import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env") });

const instanceUrl = process.env.SN_INSTANCE_URL;
const user = process.env.SN_USER;
const pass = process.env.SN_PASS;
const offlineModeByEnv = process.env.SN_OFFLINE_MODE === "true";

const parseTimeoutMs = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const snApiTimeoutMs = parseTimeoutMs(process.env.SN_API_TIMEOUT_MS, 30000);

const snClient = instanceUrl
  ? axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username: user, password: pass },
      timeout: snApiTimeoutMs,
    })
  : null;

// BR-08.1: Generate Business Rule script body
function generateBusinessRuleScript(ast) {
  const varChecks = ast.variables
    .filter((v) => v.mandatory)
    .map((v) => `  if (!current.variables.${v.name}) { gs.addErrorMessage('${v.label} is required'); current.setAbortAction(true); }`)
    .join("\n");

  return `(function executeRule(current, previous) {
  // Auto-generated Business Rule for ${ast.name}
  // Generated: ${new Date().toISOString()}

  // Mandatory field validation
${varChecks || "  // No mandatory field checks"}

  // SLA enforcement
  if (current.state == 1) {
    var slaMinutes = ${ast.sla_minutes || 480};
    current.work_notes = 'SLA set to ' + slaMinutes + ' minutes';
  }

  // Audit trail
  gs.log('BR triggered for: ' + current.number, '${ast.name}');

})(current, previous);`;
}

// BR-08.2: Generate Client Script body
function generateClientScript(ast) {
  const choiceVars = ast.variables.filter(
    (v) => v.type === "choice" && v.choices && v.choices.length > 0
  );

  const choiceValidations = choiceVars
    .map(
      (v) => `
  // Validate ${v.name} choices
  var valid_${v.name} = ${JSON.stringify(v.choices)};
  var val_${v.name} = g_form.getValue('${v.name}');
  if (val_${v.name} && !valid_${v.name}.includes(val_${v.name})) {
    g_form.showFieldMsg('${v.name}', 'Invalid selection', 'error');
    return false;
  }`
    )
    .join("\n");

  return `function onSubmit() {
  // Auto-generated Client Script for ${ast.name}
  // Generated: ${new Date().toISOString()}

  var isValid = true;

  // Mandatory field checks
${ast.variables
    .filter((v) => v.mandatory)
    .map(
      (v) => `  if (!g_form.getValue('${v.name}')) {
    g_form.showFieldMsg('${v.name}', '${v.label} is required', 'error');
    isValid = false;
  }`
    )
    .join("\n") || "  // No mandatory fields"}

  // Choice field validations
${choiceValidations || "  // No choice fields"}

  return isValid;
}`;
}

// BR-08.3: Validate script syntax (basic checks)
function validateScript(scriptBody, type) {
  const errors = [];

  if (!scriptBody || scriptBody.trim().length === 0) {
    errors.push("Script body is empty");
  }

  if (type === "business_rule") {
    if (!scriptBody.includes("current")) {
      errors.push("Business rule should reference 'current' object");
    }
    if (!scriptBody.includes("executeRule")) {
      errors.push("Business rule missing executeRule wrapper");
    }
  }

  if (type === "client_script") {
    if (!scriptBody.includes("g_form") && !scriptBody.includes("function")) {
      errors.push("Client script should contain g_form calls or functions");
    }
  }

  // Check balanced braces
  const opens = (scriptBody.match(/\{/g) || []).length;
  const closes = (scriptBody.match(/\}/g) || []).length;
  if (opens !== closes) {
    errors.push(`Unbalanced braces: ${opens} opening, ${closes} closing`);
  }

  return { valid: errors.length === 0, errors };
}

// BR-08.1: Create Business Rule in ServiceNow
export async function createBusinessRule(ast, catalogItemId, updateSetId) {
  const scriptBody = generateBusinessRuleScript(ast);
  const validation = validateScript(scriptBody, "business_rule");

  if (!validation.valid) {
    console.warn("Business rule validation warnings:", validation.errors);
  }

  const brLocal = {
    sys_id: `br_${Math.random().toString(36).substr(2, 9)}`,
    name: `BR_${ast.name.replace(/\s+/g, "_")}`,
    table_name: "sc_req_item",
    when: "before",
    insert: true,
    update: true,
    script: scriptBody,
    active: true,
    validation,
    status: "generated",
  };

  if (!snClient || offlineModeByEnv) return brLocal;

  try {
    const payload = {
      name: brLocal.name,
      collection: "sc_req_item",
      when: "before",
      insert: true,
      update: true,
      script: scriptBody,
      active: true,
      sys_update_name: updateSetId,
    };
    const resp = await snClient.post("/table/sys_script", payload);
    const sysId = resp.data.result.sys_id;
    console.log("✅ Business Rule created:", sysId);
    return { ...brLocal, sys_id: sysId, status: "created_in_sn" };
  } catch (err) {
    console.error("⚠️  Business Rule creation warning:", err.response?.data?.error?.message || err.message);
    return brLocal;
  }
}

// BR-08.2: Create Client Script in ServiceNow
export async function createClientScript(ast, catalogItemId, updateSetId) {
  const scriptBody = generateClientScript(ast);
  const validation = validateScript(scriptBody, "client_script");

  if (!validation.valid) {
    console.warn("Client script validation warnings:", validation.errors);
  }

  const csLocal = {
    sys_id: `cs_${Math.random().toString(36).substr(2, 9)}`,
    name: `CS_${ast.name.replace(/\s+/g, "_")}`,
    type: "onSubmit",
    table: "sc_cat_item",
    catalog_item: catalogItemId,
    script: scriptBody,
    active: true,
    validation,
    status: "generated",
  };

  if (!snClient || offlineModeByEnv) return csLocal;

  try {
    const payload = {
      name: csLocal.name,
      type: "onSubmit",
      table: "sc_cat_item",
      cat_item: catalogItemId,
      script: scriptBody,
      active: true,
      sys_update_name: updateSetId,
    };
    const resp = await snClient.post("/table/catalog_script_client", payload);
    const sysId = resp.data.result.sys_id;
    console.log("✅ Client Script created:", sysId);
    return { ...csLocal, sys_id: sysId, status: "created_in_sn" };
  } catch (err) {
    console.error("⚠️  Client Script creation warning:", err.response?.data?.error?.message || err.message);
    return csLocal;
  }
}

export { validateScript, generateBusinessRuleScript, generateClientScript };
