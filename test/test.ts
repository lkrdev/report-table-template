import * as chai from "chai"
// import chaiHttp from "chai-http"
import * as chaiAsPromised from "chai-as-promised"
import * as sinonChai from "sinon-chai"
import * as winston from "winston"

const chaiHttp = require("chai-http")
chai.use(chaiHttp)
chai.use(sinonChai)
chai.use(chaiAsPromised) // should be last
winston.remove(winston.transports.Console)

import "../src/actions/index"

import "../src/error_types/test_error_utils"

import "./test_action_request"
import "./test_action_response"
import "./test_actions"
import "./test_json_detail_stream"
import "./test_oauth_action"
import "./test_server"
import "./test_smoke"

import "../src/actions/excel_template/test_excel_template"
import "../src/actions/google/docs/test_google_docs"
