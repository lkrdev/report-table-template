import * as chai from "chai"

import { ActionResponse} from "../src/hub"
import type { Error } from "../src/hub/action_response"

describe("ActionResponse validation", () => {
  it("json must have a top level looker: key", (done) => {
    const response = new ActionResponse({success: false})
    const jsonResponse = response.asJson()
    chai.expect(jsonResponse.looker).to.not.be.null
    done()
  })

  it("must populate error object if provided", () => {
    const error: Error = {
      http_code: 500,
      status_code: "TEST_FAIL",
      message: "testing failure message",
      location: "actions/test_action_response",
      documentation_url: "http://test/documentation",
    }
    const response = new ActionResponse({success: false, error})
    const jsonResponse = response.asJson()
    chai.expect(jsonResponse.looker.error).to.equal(error)
  })

  it("must be a valid response if errors object is not provided", () => {
    const response = new ActionResponse({success: false})
    const jsonResponse = response.asJson()
    chai.expect(jsonResponse.looker).to.not.be.null
    chai.expect(jsonResponse.looker.success).to.equal(false)
    chai.expect(jsonResponse.looker.error).to.be.undefined
  })
})
