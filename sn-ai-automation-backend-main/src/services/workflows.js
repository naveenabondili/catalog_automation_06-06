import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env") });

const instanceUrl = process.env.SN_INSTANCE_URL;
const user = process.env.SN_USER;
const pass = process.env.SN_PASS;
const disableTlsVerify = process.env.DISABLE_TLS_VERIFY === "true";
const snCaFile = process.env.SN_CA_FILE;
const disableFdApiByEnv = process.env.SN_DISABLE_FD_API === "true";
const offlineModeByEnv = process.env.SN_OFFLINE_MODE === "true";

const parseTimeoutMs = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const snApiTimeoutMs = parseTimeoutMs(process.env.SN_API_TIMEOUT_MS, 30000);
const snFdTimeoutMs = parseTimeoutMs(process.env.SN_FD_TIMEOUT_MS, 45000);

function buildHttpsAgent() {
  if (disableTlsVerify) {
    return new https.Agent({ rejectUnauthorized: false });
  }

  if (snCaFile) {
    try {
      return new https.Agent({ ca: fs.readFileSync(snCaFile) });
    } catch (err) {
      console.warn("SN_CA_FILE could not be loaded:", err.message);
    }
  }

  return undefined;
}

const httpsAgent = buildHttpsAgent();
let fdApiDisabledForProcess = disableFdApiByEnv;
let snApiUnavailableForProcess = offlineModeByEnv;
let snOfflineLogShown = false;

function markSnApiUnavailable(reason) {
  snApiUnavailableForProcess = true;
  if (!snOfflineLogShown) {
    console.warn(`⚠️  ServiceNow API unavailable (${reason}). Using local fallback mode for this process.`);
    snOfflineLogShown = true;
  }
}

function isNetworkRetryableError(err) {
  const code = err?.code || "";
  return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND"].includes(code);
}

const snClient = instanceUrl
  ? axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username: user, password: pass },
      timeout: snApiTimeoutMs,
      httpsAgent,
    })
  : null;

// Flow Designer API — properly initializes version_record so Workflow Studio can open the flow
const fdClient = instanceUrl
  ? axios.create({
      baseURL: `${instanceUrl}/api/sn_fd`,
      auth: { username: user, password: pass },
      timeout: snFdTimeoutMs,
      httpsAgent,
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
    })
  : null;

// BR-06.1: Create flow in sys_hub_flow with real API call
export async function createFlowDesignerFlow(client, ast) {
  console.log("Creating Flow Designer flow:", ast.name);

  const steps = ast.workflow.map((step, idx) => ({
    order: idx * 100,
    name: step,
    type: step.includes("approval") ? "approval" : "action",
    label: step.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));

  // BR-06.2: Define trigger — catalog item submitted
  const trigger = {
    type: "record",
    table: "sc_request",
    condition: "active=true",
    event: "insert",
    label: "When Catalog Request is submitted",
  };

  const flowLocal = {
    sys_id: `flow_${Math.random().toString(36).substr(2, 9)}`,
    name: `Flow_${ast.name.replace(/\s+/g, "_")}`,
    description: `Auto-generated flow for ${ast.name}`,
    active: true,
    trigger,
    steps,
    status: "generated",
  };

  if (!snClient) return flowLocal;
  if (snApiUnavailableForProcess) {
    if (!snOfflineLogShown) {
      console.log("ℹ️  ServiceNow offline mode active; generating flow locally.");
      snOfflineLogShown = true;
    }
    return flowLocal;
  }

  const flowInternalName = flowLocal.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  try {
    // BR-06.1: Create flow via sn_fd API (properly initializes version_record so
    // Workflow Studio can open it). Fall back to table API if sn_fd isn't available.
    let flowSysId = null;
    const fdPayload = {
      name: flowLocal.name,
      description: flowLocal.description,
      run_as: "user",
    };
    if (!fdApiDisabledForProcess) {
      try {
        const fdResp = await fdClient.post("/flow", fdPayload);
        flowSysId = fdResp.data?.sys_id || fdResp.data?.result?.sys_id;
        if (flowSysId) console.log("✅ Flow created via Flow Designer API:", flowSysId);
      } catch (fdErr) {
        const isTimeout = fdErr.code === "ECONNABORTED" || /timeout/i.test(fdErr.message || "");
        const shouldRetry = isTimeout || isNetworkRetryableError(fdErr);
        if (shouldRetry) {
          const retryTimeoutMs = Math.min(snFdTimeoutMs * 2, 120000);
          try {
            console.warn(`⚠️  sn_fd API transient failure (${fdErr.code || "unknown"}). Retrying once with ${retryTimeoutMs}ms...`);
            const retryResp = await fdClient.post("/flow", fdPayload, { timeout: retryTimeoutMs });
            flowSysId = retryResp.data?.sys_id || retryResp.data?.result?.sys_id;
            if (flowSysId) console.log("✅ Flow created via Flow Designer API after retry:", flowSysId);
          } catch (retryErr) {
            const fdStatus = retryErr.response?.status || retryErr.code || "no-response";
            const fdDetails = retryErr.response?.data?.error?.message || retryErr.message;
            if (isNetworkRetryableError(retryErr)) {
              fdApiDisabledForProcess = true;
              console.warn("⚠️  Disabling sn_fd API for this process due to network failures; using table API fallback.");
            }
            console.warn(`⚠️  sn_fd API failed (${fdStatus}): ${fdDetails} — using table API`);
          }
        } else {
          const fdStatus = fdErr.response?.status || fdErr.code || "no-response";
          const fdDetails = fdErr.response?.data?.error?.message || fdErr.message;
          console.warn(`⚠️  sn_fd API failed (${fdStatus}): ${fdDetails} — using table API`);
        }
      }
    } else {
      console.log("ℹ️  sn_fd API disabled; creating flow via table API.");
    }
    if (!flowSysId) {
      const flowPayload = {
        name: flowLocal.name,
        description: flowLocal.description,
        active: true,
        type: "flow",
        run_as: "user",
        access: "public",
      };
      let flowResp;
      try {
        flowResp = await snClient.post("/table/sys_hub_flow", flowPayload);
      } catch (tableErr) {
        if (isNetworkRetryableError(tableErr)) {
          console.warn(`⚠️  table/sys_hub_flow transient failure (${tableErr.code}). Retrying once...`);
          try {
            flowResp = await snClient.post("/table/sys_hub_flow", flowPayload, { timeout: Math.min(snApiTimeoutMs * 2, 120000) });
          } catch (retryTableErr) {
            if (isNetworkRetryableError(retryTableErr)) {
              markSnApiUnavailable(retryTableErr.code || "network-error");
            }
            throw retryTableErr;
          }
        } else {
          throw tableErr;
        }
      }
      flowSysId = flowResp.data.result.sys_id;
      console.log("✅ Flow created via Table API:", flowSysId);
    }

    // ── Step: Create sys_hub_flow_version so Workflow Studio can open the flow ──
    // Workflow Studio reads version_record → payload.id to identify the flow.
    // The payload MUST contain "id" = the flow's sys_id, otherwise Workflow Studio
    // shows "Your flow cannot be found." Our minimal payload was missing this field.
    try {
      const vrPayload = {
        id: flowSysId,
        masterSnapshotId: "",
        name: flowLocal.name,
        internalName: flowInternalName,
        description: flowLocal.description,
        updatedBy: "admin",
        triggerInstances: [],
        actionInstances: [],
        flowLogicInstances: [],
        subFlowInstances: [],
        deleted: false,
        scope: "global",
        scopeDisplayName: "Global",
        scopeName: "global",
        isSnapshot: false,
        status: "draft",
        active: true,
        type: "flow",
        access: "public",
        runAs: "user",
        domainName: "global",
        domainId: "global",
        inputs: [],
        outputs: [],
        flowVariables: [],
        engineVersion: 2,
        versionRecordId: "",
      };
      const vrResp = await snClient.post("/table/sys_hub_flow_version", {
        flow: flowSysId,
        name: flowLocal.name,
        active: true,
        payload: JSON.stringify(vrPayload),
      });
      const vrId = vrResp.data?.result?.sys_id;
      if (vrId) {
        await snClient.patch(`/table/sys_hub_flow/${flowSysId}`, { version_record: vrId });
        console.log("✅ Flow version_record created and linked:", vrId);
      }
    } catch (vrErr) {
      console.warn("⚠️  version_record creation failed:", vrErr.response?.data?.error?.message || vrErr.message);
    }

    // BR-06.2: Create trigger
    try {
      const triggerPayload = {
        flow: flowSysId,
        type: "record_inserted",
        table_name: "sc_request",
        condition: "active=true",
      };
      await snClient.post("/table/sys_hub_trigger_instance", triggerPayload);
      console.log("✅ Flow trigger created");
    } catch (err) {
      console.warn("⚠️  Trigger creation warning:", err.response?.data?.error?.message || err.message);
    }

    // BR-06.3: Create action steps
    for (const step of steps) {
      try {
        const stepPayload = {
          flow: flowSysId,
          order: step.order,
          name: step.name,
          action_type: step.type,
        };
        await snClient.post("/table/sys_hub_action_instance", stepPayload);
        console.log(`✅ Step created: ${step.name}`);
      } catch (err) {
        console.warn(`⚠️  Step creation warning (${step.name}):`, err.response?.data?.error?.message || err.message);
      }
    }

    return {
      ...flowLocal,
      sys_id: flowSysId,
      status: "created_in_sn",
      flow_designer_url: `${instanceUrl}/flow_designer.do#/designer/flow/${flowSysId}`,
      flow_record_url: `${instanceUrl}/nav_to.do?uri=sys_hub_flow.do?sys_id=${flowSysId}`,
    };
  } catch (err) {
    console.error("⚠️  Flow creation warning:", err.response?.data?.error?.message || err.message);
    return flowLocal;
  }
}

// BR-07.1: Manager approval
// BR-07.2: Group approval
// BR-07.3: Conditional approval
export async function createApprovalRule(client, ast, flowId) {
  console.log("Creating approval rule for:", ast.name);

  if (!ast.approvals || ast.approvals.length === 0) return null;

  // Build condition expression for conditional approvals
  const conditions = ast.approvalConditions || [];
  const conditionExpr = conditions.length > 0
    ? conditions.map((c) => `${c.field}${c.operator}${c.value}`).join("^")
    : "active=true";

  const approvalLocal = {
    sys_id: `approval_${Math.random().toString(36).substr(2, 9)}`,
    name: `Approval_${ast.name.replace(/\s+/g, "_")}`,
    approvers: ast.approvals,
    approverGroups: ast.approvalGroups || [],
    flow_id: flowId,
    condition: conditionExpr,
    active: true,
    status: "generated",
  };

  if (!snClient) return approvalLocal;
  if (snApiUnavailableForProcess) return approvalLocal;

  try {
    // BR-07.1 & BR-07.2: Create approval step per approver type
    for (const approver of ast.approvals) {
      const approvalPayload = {
        name: `${approvalLocal.name}_${approver}`,
        approver: approver,
        source_table: "sc_request",
        state: "requested",
        flow: flowId,
        condition: conditionExpr,
      };

      try {
        const resp = await snClient.post("/table/sysapproval_approver", approvalPayload);
        console.log(`✅ Approval created for: ${approver}`);
      } catch (err) {
        if (isNetworkRetryableError(err)) {
          markSnApiUnavailable(err.code || "network-error");
          break;
        }
        console.warn(`⚠️  Approval warning (${approver}):`, err.response?.data?.error?.message || err.message);
      }
    }

    // BR-07.2: Group approvals
    for (const group of ast.approvalGroups || []) {
      try {
        const groupPayload = {
          name: `${approvalLocal.name}_group_${group}`,
          approver_type: "group",
          group_name: group,
          source_table: "sc_request",
          state: "requested",
          flow: flowId,
        };
        await snClient.post("/table/sysapproval_approver", groupPayload);
        console.log(`✅ Group approval created for: ${group}`);
      } catch (err) {
        if (isNetworkRetryableError(err)) {
          markSnApiUnavailable(err.code || "network-error");
          break;
        }
        console.warn(`⚠️  Group approval warning (${group}):`, err.response?.data?.error?.message || err.message);
      }
    }

    return { ...approvalLocal, status: "created_in_sn" };
  } catch (err) {
    console.error("⚠️  Approval creation warning:", err.response?.data?.error?.message || err.message);
    return approvalLocal;
  }
}
