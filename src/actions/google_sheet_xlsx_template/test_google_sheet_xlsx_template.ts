import * as chai from "chai"
import concatStream = require("concat-stream")
import * as ExcelJS from "exceljs"
import * as fs from "fs"
import * as path from "path"
import * as sinon from "sinon"
import { Readable } from "stream"
import * as Hub from "../../hub"
import { GoogleSheetXlsxTemplateAction } from "./google_sheet_xlsx_template"

const action = new GoogleSheetXlsxTemplateAction()
action.executeInOwnProcess = false

describe(`${action.constructor.name} unit tests`, () => {
  let driveSpy: sinon.SinonSpy
  let driveStub: sinon.SinonStub
  let uploadedBuffer: Buffer | null = null

  beforeEach(() => {
    uploadedBuffer = null
    driveSpy = sinon.spy(async (params: any) => {
      return new Promise<any>((resolve) => {
        params.media.body.pipe(
          concatStream((buffer) => {
            uploadedBuffer = buffer
            resolve({ data: { id: "mock_excel_file_id_123" } })
          }),
        )
      })
    })

    driveStub = sinon.stub(action as any, "driveClientFromRequest").resolves({
      files: {
        create: driveSpy,
        get: sinon.spy(async () => {
          const realTemplatePath = path.resolve(__dirname, "../../../simulate/template-example.xlsx")
          const readStream = fs.createReadStream(realTemplatePath)
          return { data: readStream }
        }),
      },
    })
  })

  afterEach(() => {
    driveStub.restore()
  })

  it("successfully parses a real json_detail_lite_stream file, " +
     "generates populated excel, and uploads to Google Drive", async () => {
    const request = new Hub.ActionRequest()
    request.type = Hub.ActionType.Query
    request.webhookId = "test_webhook_real_excel"
    request.lookerVersion = "23.0.0"
    request.params = {
      state_json: JSON.stringify({ tokens: { access_token: "mock_token" }, redirect: "http://redirect" }),
    }
    request.formParams = {
      filename: "Brand Report for {{ _filters.order_items.created_week }}",
      folder: "mock_folder_id",
      template_file_id: "mock_template_file_id",
    }
    request.scheduledPlan = {
      title: "Real File Scheduled Plan",
      scheduledPlanId: 789,
      downloadUrl: "http://example.com/download",
    }

    // Stub the stream method on ActionRequest to stream from the real example file
    request.stream = async (callback: (readable: Readable) => Promise<any>) => {
      const realFilePath = path.resolve(__dirname, "../../../example-json_detail_lite_stream.json")
      const readStream = fs.createReadStream(realFilePath)
      return callback(readStream)
    }

    const response = await action.validateAndExecute(request)

    // 1. Verify response success
    chai.expect(response.success).to.be.true
    chai.expect(response.message).to.contain("Successfully uploaded spreadsheet")

    // 2. Verify Drive upload call
    chai.expect(driveSpy).to.have.been.calledOnce
    const uploadParams = driveSpy.firstCall.args[0]

    // Verify filename resolved handlebar placeholders
    // _filters.order_items.created_week is "NOT NULL" in the json payload
    chai.expect(uploadParams.requestBody.name).to.equal("Brand Report for NOT NULL.xlsx")
    chai.expect(uploadParams.requestBody.mimeType).to.equal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    chai.expect(uploadParams.requestBody.parents).to.deep.equal(["mock_folder_id"])

    // 3. Verify Excel workbook contents
    chai.expect(uploadedBuffer).to.not.be.null
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(uploadedBuffer! as any)
    const sheet = workbook.worksheets[0]
    chai.expect(sheet).to.exist

    // Verify logo image was programmatically added
    const images = sheet.getImages()
    chai.expect(images).to.have.lengthOf(1)
    const img = images[0]
    chai.expect(img.imageId).to.exist
    chai.expect(Math.floor(img.range.tl.col)).to.equal(0) // Column A (0-indexed)
    chai.expect(Math.floor(img.range.tl.row)).to.equal(0) // Row 1 (0-indexed)

    // Assert standard cells
    chai.expect(sheet.getCell("B4").value).to.be.a("string") // run_at timestamp
    chai.expect(sheet.getCell("B5").value).to.equal("Real File Scheduled Plan") // title
    chai.expect(sheet.getCell("B7").value).to.be.oneOf([null, undefined, ""])
    chai.expect(sheet.getCell("B8").value).to.be.oneOf([null, undefined, ""])
    chai.expect(sheet.getCell("C10").value).to.be.oneOf([null, undefined, ""])

    // Assert repeating rows (should have 183 rows of data)
    // Row 11 is the first row of data
    chai.expect(sheet.getCell("A11").value).to.equal("2022-12-26") // order_items.created_week
    chai.expect(sheet.getCell("B11").value).to.be.oneOf([null, undefined, ""]) // columns[2] (out of bounds)
    chai.expect(sheet.getCell("C11").value).to.be.oneOf([null, undefined, ""]) // data.users.state (not in query)
    chai.expect(sheet.getCell("D11").value).to.be.oneOf([null, undefined, ""]) // data.order_items.count (not in query)

    // Assert the last row of data (row 193)
    // index 182 in the payload is the 183rd row
    chai.expect(sheet.getCell("A193").value).to.equal("2026-06-22")

    // Assert footer rows shifted down by 182 rows
    // Original template: "This is a footer!" was at row 15
    // Shifted: "This is a footer!" is at row 197
    chai.expect(sheet.getCell("A197").value).to.equal("This is a footer!")

    // Assert that the _errors sheet exists and contains the expected unresolved mustaches
    const errorsSheet = workbook.getWorksheet("_errors")
    chai.expect(errorsSheet).to.exist
    const errorMessages: string[] = []
    errorsSheet!.eachRow((row) => {
      const cellVal = row.getCell(1).value
      if (cellVal !== undefined && cellVal !== null) {
        errorMessages.push(String(cellVal))
      }
    })

    chai.expect(errorMessages).to.have.lengthOf(6)
    chai.expect(errorMessages).to.include("Could not find {{ data._columns[2] }}")
    chai.expect(errorMessages).to.include("Could not find {{ data.users.state }}")
    chai.expect(errorMessages).to.include("Could not find {{ data.order_items.count }}")
    chai.expect(errorMessages).to.include("Could not find {{ _filters.users.state }}")
    chai.expect(errorMessages).to.include("Could not find {{ data[0].products.brand }}")
    chai.expect(errorMessages).to.include("Could not find {{ fields.users.state.label }}")
  })

  it("successfully strips HTML and converts formatted numbers with commas to Excel numbers", async () => {
    const request = new Hub.ActionRequest()
    request.type = Hub.ActionType.Query
    request.webhookId = "test_webhook_html_strip"
    request.lookerVersion = "23.0.0"
    request.params = {
      state_json: JSON.stringify({
        tokens: { access_token: "mock_token" },
        redirect: "http://redirect",
      }),
    }
    request.formParams = {
      filename: "HTML Report",
      folder: "mock_folder_id",
      template_file_id: "mock_template_file_id",
    }
    request.scheduledPlan = {
      title: "HTML Test",
      scheduledPlanId: 789,
      downloadUrl: "http://example.com/download",
    }

    const mockPayload = {
      fields: {
        dimensions: [
          { name: "order_items.created_week", label: "Created Week" },
          { name: "users.state", label: "State" },
        ],
        measures: [
          { name: "order_items.count", label: "Count" },
        ],
      },
      data: [
        {
          "order_items.created_week": { value: "<a href='#'>2026-06-24</a>" },
          "users.state": { value: "<a href='#'>California</a>" },
          "order_items.count": { value: "<a href='#'>4,214</a>" },
        },
      ],
    }

    request.stream = async (callback: (readable: Readable) => Promise<any>) => {
      const readStream = Readable.from([JSON.stringify(mockPayload)])
      return callback(readStream)
    }

    const response = await action.validateAndExecute(request)

    chai.expect(response.success).to.be.true

    chai.expect(uploadedBuffer).to.not.be.null
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(uploadedBuffer! as any)
    const sheet = workbook.worksheets[0]
    chai.expect(sheet).to.exist

    // Assert repeating rows (should have 1 row of data starting at row 11)
    chai.expect(sheet.getCell("A11").value).to.equal("2026-06-24") // html stripped
    chai.expect(sheet.getCell("C11").value).to.equal("California") // html stripped
    chai.expect(sheet.getCell("D11").value).to.equal(4214) // html stripped and parsed as number
    chai.expect(typeof sheet.getCell("D11").value).to.equal("number") // verify type is number
  })
})
