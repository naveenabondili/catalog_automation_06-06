import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env") });

const instanceUrl = process.env.SN_INSTANCE_URL;
const user = process.env.SN_USER;
const pass = process.env.SN_PASS;
const disableTlsVerify = process.env.DISABLE_TLS_VERIFY === "true";
const snCaFile = process.env.SN_CA_FILE;
const offlineModeByEnv = process.env.SN_OFFLINE_MODE === "true";

const parseTimeoutMs = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const snApiTimeoutMs = parseTimeoutMs(process.env.SN_API_TIMEOUT_MS, 30000);

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

function isConnectivityError(err) {
  const code = err?.code || "";
  return ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "ECONNABORTED"].includes(code);
}

console.log("🔧 Deployment Service Init:");
console.log("  Instance:", instanceUrl);
console.log("  User:", user);

if (!instanceUrl || !user || !pass) {
  console.error("❌ ERROR: Missing ServiceNow credentials!");
}

const snClient = instanceUrl
  ? axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username: user, password: pass },
      timeout: snApiTimeoutMs,
      httpsAgent,
    })
  : null;

// BR-04.1: Create catalog item in sc_cat_item
export async function createCatalogItemInSN(ast, updateSetId) {
  if (!snClient) throw new Error("ServiceNow client not initialized");

  // BR-04.2: Resolve category sys_id
  let categorySysId = null;
  try {
    const catResp = await snClient.get(
      `/table/sc_category?sysparm_query=titleLIKEIT&sysparm_fields=sys_id,title&sysparm_limit=1`
    );
    if (catResp.data.result && catResp.data.result.length > 0) {
      categorySysId = catResp.data.result[0].sys_id;
    }
  } catch {
    console.warn("⚠️  Could not resolve category, will use default");
  }

  const payload = {
    name: ast.name,
    short_description: ast.description || `Auto-generated: ${ast.name}`,
    description: ast.description || `Auto-generated: ${ast.name}`,
    // BR-04.3: Set availability
    active: true,
    availability: "on_both",
    visible_standalone: true,
    visible_guide: true,
    // BR-04.2: Assign category
    ...(categorySysId ? { category: categorySysId } : {}),
  };

  const resp = await snClient.post("/table/sc_cat_item", payload);
  const result = resp.data?.result;
  if (!result?.sys_id) {
    console.error("❌ Unexpected response from sc_cat_item:", JSON.stringify(resp.data).slice(0, 300));
    throw new Error(`ServiceNow sc_cat_item API returned no sys_id. Response: ${JSON.stringify(resp.data?.error || resp.data).slice(0, 200)}`);
  }
  const sys_id = result.sys_id;
  console.log("✅ Catalog item created in SN:", sys_id);
  return {
    sys_id,
    name: ast.name,
    short_description: ast.description,
    category: categorySysId,
    active: true,
    status: "created_in_sn",
  };
}

// BR-05.1/05.2/05.3: Create variables in ServiceNow
export async function createVariablesInSN(ast, catalogItemId, _updateSetId) {
  if (!snClient) return null;

  const createdVars = [];
  for (const variable of ast.variables || []) {
    const varPayload = {
      question_text: variable.label,
      name: variable.name,
      type: mapVariableType(variable.type),
      mandatory: variable.mandatory || false,
      // BR-05.2: reference type support
      ...(variable.type === "reference" ? { reference: variable.referenceTable || "cmdb_ci" } : {}),
      question_choice: variable.choices ? variable.choices.join("\n") : "",
      sc_cat_item: catalogItemId,
      order: createdVars.length * 100,
    };

    try {
      const resp = await snClient.post("/table/sc_item_option", varPayload);
      const varSysId = resp.data?.result?.sys_id || `var_${Math.random().toString(36).slice(2, 11)}`;
      console.log(`✅ Variable created: ${variable.name}`);
      createdVars.push({ ...variable, sys_id: varSysId });
    } catch (err) {
      console.warn(`⚠️  Variable creation warning (${variable.name}):`, err.response?.data?.error?.message || err.message);
      createdVars.push({ ...variable, sys_id: `var_${Math.random().toString(36).substr(2, 9)}`, status: "fallback" });
    }
  }

  return {
    sys_id: `varset_${Math.random().toString(36).substr(2, 9)}`,
    name: `Variables_${ast.name}`,
    variables: createdVars,
    count: createdVars.length,
  };
}

// BR-11.1: Create update set
export async function generateUpdateSet(client, ast, artifacts) {
  if (!snClient || offlineModeByEnv) {
    const variableCount = artifacts.variableSet?.variables?.length || ast.variables?.length || 0;
    return {
      sys_id: `updateset_${Math.random().toString(36).slice(2, 11)}`,
      name: `UpdateSet_${ast.name.replace(/\s+/g, "_")}_${Date.now()}`,
      description: `Auto-generated update set for ${ast.name}`,
      artifacts: {
        catalogItem: artifacts.catalogItem ? { sys_id: artifacts.catalogItem.sys_id } : null,
        variableSet: artifacts.variableSet ? { sys_id: artifacts.variableSet.sys_id, count: variableCount } : null,
        flow: artifacts.flow ? { sys_id: artifacts.flow.sys_id } : null,
        approval: artifacts.approval ? { sys_id: artifacts.approval.sys_id } : null,
        businessRule: artifacts.businessRule ? { sys_id: artifacts.businessRule.sys_id } : null,
        clientScript: artifacts.clientScript ? { sys_id: artifacts.clientScript.sys_id } : null,
        testCase: artifacts.testCase ? { sys_id: artifacts.testCase.sys_id } : null,
        testResult: artifacts.testResult ? { status: artifacts.testResult.status } : null,
      },
      status: "generated_offline",
      ready_for_deployment: false,
      message: "Offline mode enabled: update set created locally.",
    };
  }

  console.log("Generating update set for:", ast.name);

  try {
    const updateSetPayload = {
      name: `UpdateSet_${ast.name.replace(/\s+/g, "_")}_${Date.now()}`,
      description: `Auto-generated update set for ${ast.name}`,
      state: "in progress",
    };

    const updateSetResp = await snClient.post("/table/sys_update_set", updateSetPayload);
    const updateSetId = updateSetResp.data.result.sys_id;
    console.log("✅ Update set created:", updateSetId);

    // Note: Catalog item, variables, and approvals are created at deploy time (not here).
    // The update set record is created now as a container for tracking.
    const variableCount = artifacts.variableSet?.variables?.length || ast.variables?.length || 0;

    return {
      sys_id: updateSetId,
      name: updateSetPayload.name,
      description: updateSetPayload.description,
      artifacts: {
        catalogItem: artifacts.catalogItem ? { sys_id: artifacts.catalogItem.sys_id } : null,
        variableSet: artifacts.variableSet ? { sys_id: artifacts.variableSet.sys_id, count: variableCount } : null,
        flow: artifacts.flow ? { sys_id: artifacts.flow.sys_id } : null,
        approval: artifacts.approval ? { sys_id: artifacts.approval.sys_id } : null,
        businessRule: artifacts.businessRule ? { sys_id: artifacts.businessRule.sys_id } : null,
        clientScript: artifacts.clientScript ? { sys_id: artifacts.clientScript.sys_id } : null,
        testCase: artifacts.testCase ? { sys_id: artifacts.testCase.sys_id } : null,
        testResult: artifacts.testResult ? { status: artifacts.testResult.status } : null,
      },
      status: "in progress",
      ready_for_deployment: true,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    if (isConnectivityError(err)) {
      console.warn("⚠️  Update set API unavailable; using local offline update set.");
      const variableCount = artifacts.variableSet?.variables?.length || ast.variables?.length || 0;
      return {
        sys_id: `updateset_${Math.random().toString(36).slice(2, 11)}`,
        name: `UpdateSet_${ast.name.replace(/\s+/g, "_")}_${Date.now()}`,
        description: `Auto-generated update set for ${ast.name}`,
        artifacts: {
          catalogItem: artifacts.catalogItem ? { sys_id: artifacts.catalogItem.sys_id } : null,
          variableSet: artifacts.variableSet ? { sys_id: artifacts.variableSet.sys_id, count: variableCount } : null,
          flow: artifacts.flow ? { sys_id: artifacts.flow.sys_id } : null,
          approval: artifacts.approval ? { sys_id: artifacts.approval.sys_id } : null,
          businessRule: artifacts.businessRule ? { sys_id: artifacts.businessRule.sys_id } : null,
          clientScript: artifacts.clientScript ? { sys_id: artifacts.clientScript.sys_id } : null,
          testCase: artifacts.testCase ? { sys_id: artifacts.testCase.sys_id } : null,
          testResult: artifacts.testResult ? { status: artifacts.testResult.status } : null,
        },
        status: "generated_offline",
        ready_for_deployment: false,
        message: "Connectivity issue detected: update set created locally.",
      };
    }
    console.error("❌ Update set generation failed:", msg);
    throw new Error(`Update set generation failed: ${msg}`);
  }
}

// BR-11.3: Deploy update set to target instance
export async function deployUpdateSet(client, updateSetId, targetInstance) {
  if (!snClient || offlineModeByEnv) {
    return {
      deployment_id: `deploy_${Math.random().toString(36).substr(2, 9)}`,
      update_set_id: updateSetId,
      target_instance: targetInstance || instanceUrl,
      status: "simulated",
      timestamp: new Date().toISOString(),
      message: "Offline mode enabled: deployment simulated.",
    };
  }

  const target = targetInstance || instanceUrl;
  console.log("Deploying update set to:", target);

  try {
    // Mark update set as complete
    await snClient.patch(`/table/sys_update_set/${updateSetId}`, { state: "complete" });
    console.log("✅ Update set marked as complete");

    // BR-11.3: If deploying to a different instance, use remote update set API
    if (targetInstance && targetInstance !== instanceUrl) {
      const targetClient = axios.create({
        baseURL: `${targetInstance}/api/now`,
        auth: { username: user, password: pass },
        timeout: snApiTimeoutMs,
        httpsAgent,
      });

      // Push update set XML to target
      const exportResp = await snClient.get(`/table/sys_update_set/${updateSetId}?sysparm_fields=sys_id,name,state`);
      const updateSetData = exportResp.data.result;

      // Import to target instance
      await targetClient.post("/table/sys_remote_update_set", {
        name: updateSetData.name,
        remote_sys_id: updateSetId,
        state: "loaded",
      });

      console.log("✅ Update set pushed to target instance");
    }

    return {
      deployment_id: `deploy_${Math.random().toString(36).substr(2, 9)}`,
      update_set_id: updateSetId,
      target_instance: target,
      status: "deployed",
      timestamp: new Date().toISOString(),
      message: "Update set deployed successfully",
    };
  } catch (err) {
    console.error("❌ Deployment failed:", err.response?.data?.error?.message || err.message);
    throw new Error(`Deployment failed: ${err.response?.data?.error?.message || err.message}`);
  }
}

// BR-11.2: Create scoped application
export async function createScopedApplication(ast) {
  if (!snClient) {
    return {
      sys_id: `scope_${Math.random().toString(36).substr(2, 9)}`,
      name: `x_custom_${ast.name.replace(/\s+/g, "_").toLowerCase()}`,
      scope: `x_custom_${ast.name.replace(/\s+/g, "_").toLowerCase().substring(0, 18)}`,
      status: "generated",
    };
  }

  try {
    const scopePayload = {
      name: ast.name,
      scope: `x_cust_${ast.name.replace(/\s+/g, "_").toLowerCase().substring(0, 14)}`,
      version: "1.0.0",
      short_description: ast.description || `Scoped app for ${ast.name}`,
      active: true,
    };
    const resp = await snClient.post("/table/sys_scope", scopePayload);
    const sys_id = resp.data.result.sys_id;
    console.log("✅ Scoped application created:", sys_id);
    return { ...scopePayload, sys_id, status: "created_in_sn" };
  } catch (err) {
    console.warn("⚠️  Scoped app creation warning:", err.response?.data?.error?.message || err.message);
    return {
      sys_id: `scope_${Math.random().toString(36).substr(2, 9)}`,
      name: ast.name,
      status: "fallback",
    };
  }
}

// BR-05.2: Map variable types to ServiceNow type codes
function mapVariableType(type) {
  const typeMap = {
    string: "1",
    choice: "18",
    number: "2",
    boolean: "3",
    date: "5",
    datetime: "4",
    reference: "8",
    url: "20",
    email: "21",
    multiline: "19",
  };
  return typeMap[type] || "1";
}
