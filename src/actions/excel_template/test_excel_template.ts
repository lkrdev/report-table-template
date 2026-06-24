import * as chai from "chai"
import concatStream = require("concat-stream")
import * as fs from "fs"
import * as path from "path"
import * as sinon from "sinon"
import { Readable } from "stream"
import * as XLSX from "xlsx"
import * as Hub from "../../hub"
import { ExcelTemplateAction } from "./excel_template"

const action = new ExcelTemplateAction()
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
    const workbook = XLSX.read(uploadedBuffer!, { type: "buffer" })
    const sheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[sheetName]
    chai.expect(sheet).to.exist

    // Assert standard cells
    chai.expect(sheet.B3?.v).to.be.a("string") // run_at timestamp
    chai.expect(sheet.B4?.v).to.equal("Real File Scheduled Plan") // title
    chai.expect(sheet.B6?.v).to.equal("") // users.state filter (not in query filters, so empty)
    chai.expect(sheet.B7?.v).to.equal("") // products.brand has no value (field not in query)
    chai.expect(sheet.C8?.v).to.equal("") // users.state label (field not in query)

    // Assert repeating rows (should have 183 rows of data)
    // Row 9 is the first row of data
    chai.expect(sheet.A9?.v).to.equal("2022-12-26") // order_items.created_week
    chai.expect(sheet.B9?.v).to.equal("") // columns[2] (out of bounds)
    chai.expect(sheet.C9?.v).to.equal("") // data.users.state (not in query)
    chai.expect(sheet.D9?.v).to.equal("") // data.order_items.count (not in query)

    // Assert the last row of data (row 191)
    // index 182 in the payload is the 183rd row
    chai.expect(sheet.A191?.v).to.equal("2026-06-22")

    // Assert footer rows shifted down by 182 rows
    // Original template: "Footer" was at row 12, "Bryan is Kewl" was at row 13
    // Shifted: "Footer" is at row 194, "Bryan is Kewl" is at row 195
    chai.expect(sheet.A194?.v).to.equal("Footer")
    chai.expect(sheet.A195?.v).to.equal("Bryan is Kewl")
  })
})
