import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { generateBusinessRuleScript, generateClientScript } from "./scripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env") });

const instanceUrl = process.env.SN_INSTANCE_URL;
const user = process.env.SN_USER;
const pass = process.env.SN_PASS;
const disableTlsVerify = process.env.DISABLE_TLS_VERIFY === "true";
const snCaFile = process.env.SN_CA_FILE;
const requestTimeoutMs = Number.parseInt(process.env.SN_API_TIMEOUT_MS || "30000", 10) || 30000;
const offlineModeByEnv = process.env.SN_OFFLINE_MODE === "true";

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

console.log("ServiceNow Config:");
console.log("  Instance:", instanceUrl);
console.log("  User:", user);

const client = axios.create({
  baseURL: `${instanceUrl}/api/now`,
  auth: { username: user, password: pass },
  timeout: requestTimeoutMs,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

function isConnectivityError(err) {
  const code = err?.code || "";
  return ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "ECONNABORTED"].includes(code);
}

function snDateTimeUTC(date = new Date()) {
  // ServiceNow sysparm_query expects UTC in "YYYY-MM-DD HH:mm:ss"
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function buildUpdateSetHeaders(updateSetId) {
  if (!updateSetId) return {};
  // Different instances/plugins honor different header names.
  return {
    "X-Update-Set": updateSetId,
    "X-Update-Set-ID": updateSetId,
  };
}

function trimName(value, max = 100) {
  const text = String(value || "").trim();
  if (!text) return "Auto Generated Script";
  return text.length > max ? text.slice(0, max) : text;
}

function buildActionBasedScriptNames(catalogName, variables) {
  const safeCatalogName = String(catalogName || "Service Request").trim();
  const hasMandatory = (variables || []).some((v) => !!v.mandatory);
  const hasChoiceValidation = (variables || []).some((v) => Array.isArray(v.choices) && v.choices.length > 0);

  const brActions = [
    hasMandatory ? "Validate Mandatory Fields" : "Process Request",
    "Write Audit Notes",
  ];

  const csActions = [
    hasMandatory ? "Validate Mandatory Fields" : "Form Validation",
    hasChoiceValidation ? "Validate Choices" : "Submit Guard",
  ];

  return {
    businessRuleName: trimName(`BR ${safeCatalogName} - ${brActions.join(" + ")}`),
    clientScriptName: trimName(`CS ${safeCatalogName} - ${csActions.join(" + ")}`),
  };
}

async function upsertBusinessRuleForCatalogItem(catalogItemSysId, scriptName, scriptBody, updateSetHeaders, updateSetId) {
  const query = `collection=sc_req_item^name=${scriptName}^filter_conditionLIKEcat_item=${catalogItemSysId}`;
  const existing = await client.get(
    `/table/sys_script?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id&sysparm_limit=1`
  );

  const existingSysId = existing.data?.result?.[0]?.sys_id || null;
  const payload = {
    name: scriptName,
    collection: "sc_req_item",
    when: "before",
    insert: true,
    update: true,
    active: true,
    script: scriptBody,
    filter_condition: `cat_item=${catalogItemSysId}`,
    sys_update_name: updateSetId,
  };

  if (existingSysId) {
    const updated = await client.patch(`/table/sys_script/${existingSysId}`, payload, { headers: updateSetHeaders });
    return { sys_id: updated.data?.result?.sys_id || existingSysId, status: "updated" };
  }

  const created = await client.post("/table/sys_script", payload, { headers: updateSetHeaders });
  return { sys_id: created.data?.result?.sys_id, status: "created" };
}

async function upsertClientScriptForCatalogItem(catalogItemSysId, scriptName, scriptBody, updateSetHeaders, updateSetId) {
  const query = `cat_item=${catalogItemSysId}^type=onSubmit^name=${scriptName}`;
  const existing = await client.get(
    `/table/catalog_script_client?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id&sysparm_limit=1`
  );

  const existingSysId = existing.data?.result?.[0]?.sys_id || null;
  const payload = {
    name: scriptName,
    type: "onSubmit",
    table: "sc_cat_item",
    cat_item: catalogItemSysId,
    active: true,
    script: scriptBody,
    sys_update_name: updateSetId,
  };

  if (existingSysId) {
    const updated = await client.patch(`/table/catalog_script_client/${existingSysId}`, payload, { headers: updateSetHeaders });
    return { sys_id: updated.data?.result?.sys_id || existingSysId, status: "updated" };
  }

  const created = await client.post("/table/catalog_script_client", payload, { headers: updateSetHeaders });
  return { sys_id: created.data?.result?.sys_id, status: "created" };
}

async function setCurrentUpdateSet(updateSetId) {
  if (!updateSetId) return;

  const attempts = [
    { method: "put", path: "/ui/concoursepicker/updateset", data: { sysId: updateSetId } },
    { method: "put", path: "/ui/concoursepicker/updateset", data: { sys_id: updateSetId } },
    { method: "post", path: "/ui/concoursepicker/updateset", data: { sysId: updateSetId } },
  ];

  for (const attempt of attempts) {
    try {
      await client.request({ method: attempt.method, url: attempt.path, data: attempt.data });
      console.log("Current update set context switched:", updateSetId);
      return;
    } catch {
      // Try the next variant.
    }
  }

  console.warn("Could not switch current update set via UI API; continuing with header fallback.");
}

async function moveRecentCustomerUpdatesToSet(updateSetId, deploymentStartedAt) {
  if (!updateSetId || !deploymentStartedAt) return;

  const started = snDateTimeUTC(deploymentStartedAt);
  const q = [
    `sys_created_by=${user}`,
    `sys_created_on>=${started}`,
    `update_set!=${updateSetId}`,
  ].join("^");

  try {
    const resp = await client.get(
      `/table/sys_update_xml?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=sys_id,name,update_set&sysparm_limit=200`
    );

    const rows = resp.data?.result || [];
    if (rows.length === 0) return;

    let moved = 0;
    for (const row of rows) {
      try {
        await client.patch(`/table/sys_update_xml/${row.sys_id}`, { update_set: updateSetId });
        moved += 1;
      } catch {
        // Continue with others.
      }
    }

    if (moved > 0) {
      console.log(`Reassigned ${moved} customer update(s) into update set ${updateSetId}`);
    }
  } catch (err) {
    console.warn("Customer update reassignment skipped:", err.response?.data?.error?.message || err.message);
  }
}

// Map variable types to ServiceNow type codes
function mapVarType(type) {
  return {
    // Service Catalog variable type codes for item_option_new
    string: "4",      // Single Line Text
    multiline: "2",   // Multi Line Text
    choice: "5",      // Select Box
    number: "6",      // Integer
    boolean: "1",     // Yes/No
    date: "9",        // Date
    datetime: "10",   // Date/Time
    reference: "8",
    url: "16",
    email: "27",
  }[type] || "4";
}

function sanitizeVariableName(name, index) {
  const fallback = `var_${index + 1}`;
  const raw = String(name || "").trim() || fallback;
  // ServiceNow variable names should be lowercase and use underscores.
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

function normalizeChoices(rawChoices) {
  if (!rawChoices) return [];

  const toLabelValue = (item) => {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) return null;
      return { text, value: text };
    }

    if (item && typeof item === "object") {
      const text = String(item.text ?? item.label ?? item.value ?? "").trim();
      const value = String(item.value ?? item.text ?? item.label ?? "").trim();
      if (!text && !value) return null;
      return { text: text || value, value: value || text };
    }

    const text = String(item || "").trim();
    if (!text) return null;
    return { text, value: text };
  };

  const normalized = Array.isArray(rawChoices)
    ? rawChoices.map(toLabelValue).filter(Boolean)
    : String(rawChoices)
      .split(",")
      .map((s) => toLabelValue(s))
      .filter(Boolean);

  // De-duplicate by value (case-insensitive) while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const choice of normalized) {
    const key = choice.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(choice);
  }
  return deduped;
}

async function ensureVariableMtomLink(catalogItemSysId, variableSysId, order, headers) {
  const query = `sc_cat_item=${catalogItemSysId}^sc_item_option=${variableSysId}`;
  const existing = await client.get(
    `/table/sc_item_option_mtom?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id&sysparm_limit=1`
  );

  if ((existing.data?.result || []).length > 0) return;

  await client.post(
    "/table/sc_item_option_mtom",
    {
      sc_cat_item: catalogItemSysId,
      sc_item_option: variableSysId,
      order,
    },
    { headers }
  );
}

async function resolveExistingCatalogItemSysId(cat) {
  const targetLookupSysId = String(cat?.target_lookup_sys_id || "").trim();
  const candidateId = targetLookupSysId || String(cat?.sys_id || "").trim();

  // Ignore local placeholder IDs (e.g. cat_ab12cd34).
  if (candidateId && !candidateId.startsWith("cat_")) {
    try {
      const byId = await client.get(`/table/sc_cat_item/${candidateId}?sysparm_fields=sys_id,name`);
      if (byId.data?.result?.sys_id) return byId.data.result.sys_id;
    } catch {
      // Fall through to lookup by name.
    }
  }

  const name = String(cat?.target_lookup_name || cat?.name || "").trim();
  if (!name) return null;

  try {
    const byName = await client.get(
      `/table/sc_cat_item?sysparm_query=name=${encodeURIComponent(name)}&sysparm_fields=sys_id,name&sysparm_limit=1`
    );
    return byName.data?.result?.[0]?.sys_id || null;
  } catch {
    return null;
  }
}

async function upsertCatalogVariable(catalogItemSysId, variable, index, headers) {
  const variableName = sanitizeVariableName(variable.name, index);
  const variableLabel = String(variable.label || variable.name || variableName);
  const variableOrder = (index + 1) * 100;

  const payload = {
    question_text: variableLabel,
    name: variableName,
    type: mapVarType(variable.type),
    mandatory: !!variable.mandatory,
    default_value: variable.defaultValue || "",
    cat_item: catalogItemSysId,
    order: variableOrder,
    active: true,
    ...(variable.type === "reference" && variable.referenceTable ? { reference: variable.referenceTable } : {}),
  };

  const candidateId = String(variable?.sys_id || "").trim();
  let variableSysId = null;
  let operation = "created";

  if (candidateId && !candidateId.startsWith("var_")) {
    try {
      const byId = await client.get(`/table/item_option_new/${candidateId}?sysparm_fields=sys_id,cat_item`);
      const found = byId.data?.result;
      if (found?.sys_id && (!found.cat_item || found.cat_item === catalogItemSysId || found.cat_item?.value === catalogItemSysId)) {
        variableSysId = found.sys_id;
      }
    } catch {
      // Fall through to query by name/label.
    }
  }

  if (!variableSysId) {
    const existingByName = await client.get(
      `/table/item_option_new?sysparm_query=cat_item=${catalogItemSysId}^name=${encodeURIComponent(variableName)}&sysparm_fields=sys_id&sysparm_limit=1`
    );
    variableSysId = existingByName.data?.result?.[0]?.sys_id || null;
  }

  if (!variableSysId && variableLabel) {
    const existingByLabel = await client.get(
      `/table/item_option_new?sysparm_query=cat_item=${catalogItemSysId}^question_text=${encodeURIComponent(variableLabel)}&sysparm_fields=sys_id&sysparm_limit=1`
    );
    variableSysId = existingByLabel.data?.result?.[0]?.sys_id || null;
  }

  if (variableSysId) {
    const updateResp = await client.patch(`/table/item_option_new/${variableSysId}`, payload, { headers });
    variableSysId = updateResp.data?.result?.sys_id || variableSysId;
    operation = "updated";
  } else {
    const createResp = await client.post("/table/item_option_new", payload, { headers });
    variableSysId = createResp.data?.result?.sys_id || null;
    if (!variableSysId) {
      const lu = await client.get(
        `/table/item_option_new?sysparm_query=cat_item=${catalogItemSysId}^name=${encodeURIComponent(variableName)}&sysparm_fields=sys_id&sysparm_limit=1`
      );
      variableSysId = lu.data?.result?.[0]?.sys_id || null;
    }
  }

  if (!variableSysId) {
    throw new Error(`No sys_id returned for variable ${variableName}`);
  }

  await ensureVariableMtomLink(catalogItemSysId, variableSysId, variableOrder, headers);

  return {
    sys_id: variableSysId,
    name: variableName,
    label: variableLabel,
    type: variable.type,
    mandatory: !!variable.mandatory,
    choices: variable.choices || [],
    referenceTable: variable.referenceTable || null,
    defaultValue: variable.defaultValue || null,
    status: operation,
  };
}

async function createAtfStepConfigResolver() {
  const cache = new Map();
  const index = new Map();

  try {
    const cfgResp = await client.get(
      "/table/sys_atf_step_config?sysparm_fields=sys_id,name,internal_name&sysparm_limit=1000"
    );

    for (const cfg of cfgResp.data?.result || []) {
      const keys = [cfg.name, cfg.internal_name].filter(Boolean).map((k) => String(k).toLowerCase());
      for (const key of keys) {
        if (!index.has(key)) index.set(key, cfg.sys_id);
      }
    }

    console.log(`ATF step configs indexed: ${index.size}`);
  } catch (cfgErr) {
    console.warn("ATF step config preload failed:", cfgErr.response?.data?.error?.message || cfgErr.message);
  }

  const aliases = {
    navigate: ["open a catalog item", "open a page"],
    open_catalog_item: ["open a catalog item", "open a page"],
    fill_variables: ["set variable values", "set field values", "set field values in an order guide"],
    set_field: ["set variable values", "set field values"],
    submit: ["click a ui action", "click a button"],
    submit_request: ["click a ui action", "click a button"],
    assert: ["field values validation", "record validation", "assert"],
    verify_status: ["record validation", "field values validation", "assert"],
    verify_approval: ["record validation", "field values validation", "assert"],
  };

  return function resolve(action) {
    const normalized = (action || "").toLowerCase();
    if (!normalized) return null;
    if (cache.has(normalized)) return cache.get(normalized);

    const searchTerms = [normalized, ...(aliases[normalized] || [])];
    for (const term of searchTerms) {
      const key = term.toLowerCase();
      if (index.has(key)) {
        const id = index.get(key);
        cache.set(normalized, id);
        return id;
      }
    }

    cache.set(normalized, null);
    return null;
  };
}

async function createAtfStepWithFallback(atfSysId, step, updateSetId) {
  const headers = buildUpdateSetHeaders(updateSetId);
  const basePayload = {
    test: atfSysId,
    order: step.order,
    description: step.description,
    active: true,
    inputs: step.inputs,
  };

  const tryPayloads = [
    step.step_config ? { ...basePayload, step_config: step.step_config } : basePayload,
    { ...basePayload, action_name: (step.action || "").toLowerCase() || "assert" },
  ];

  let lastError = null;
  for (const payload of tryPayloads) {
    try {
      await client.post("/table/sys_atf_step", payload, { headers });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unknown ATF step creation failure");
}

export async function deployToServiceNow(artifacts) {
  const deployedIds = {};
  const warnings = [];
  const deploymentStartedAt = new Date();
  const variableDetails = [];

  if (offlineModeByEnv) {
    const cat = artifacts?.catalogItem || {};
    const localVars = artifacts?.variableSet?.variables || [];
    return {
      success: true,
      deployment_mode: "simulated",
      catalog_item_id: cat.sys_id || `cat_${Math.random().toString(36).slice(2, 11)}`,
      update_set_id: artifacts?.updateSet?.sys_id || `updateset_${Math.random().toString(36).slice(2, 11)}`,
      instance_url: null,
      atf_test_url: null,
      deployed_ids: {
        catalogItem: cat.sys_id || null,
        variables: localVars.map((v) => v.sys_id).filter(Boolean),
        approvals: artifacts?.approval?.approvers || [],
      },
      variable_details: localVars,
      warnings: ["Offline mode enabled: ServiceNow deployment simulated."],
      deployed_at: new Date().toISOString(),
      message: `Catalog item "${cat.name || "Service Request"}" simulated deployment completed`,
    };
  }

  try {
    console.log("Deploying to ServiceNow...");

    // Step 1: Create Update Set
    const cat = artifacts.catalogItem;
    if (!cat) throw new Error("No catalog item data in artifacts");

    const usResp = await client.post("/table/sys_update_set", {
      name: `Deploy_${cat.name}_${Date.now()}`,
      description: `Deployed by AI Automation Platform - ${cat.name}`,
      state: "in progress",
    });

    const updateSetId = usResp.data?.result?.sys_id;
    if (!updateSetId) throw new Error("Failed to create update set in ServiceNow");

    console.log("Update set created:", updateSetId);
    deployedIds.updateSet = updateSetId;

    const updateSetHeaders = buildUpdateSetHeaders(updateSetId);
    await setCurrentUpdateSet(updateSetId);

    // Step 2: Resolve category + owning catalog
    let categorySysId = null;
    let catalogSysId = null;

    try {
      const catRes = await client.get(
        "/table/sc_category?sysparm_query=active=true&sysparm_fields=sys_id,title,sc_catalog&sysparm_limit=10"
      );
      const cats = catRes.data?.result || [];
      const chosen = cats.find((c) => c.sc_catalog?.value) || cats[0];
      if (chosen) {
        categorySysId = chosen.sys_id;
        catalogSysId = chosen.sc_catalog?.value || null;
        console.log(`Category resolved: ${chosen.title} (${categorySysId})`);
      }
    } catch (err) {
      console.warn("Could not resolve category:", err.message);
    }

    if (!categorySysId) {
      throw new Error("No active sc_category found. Create a category in ServiceNow -> Service Catalog -> Categories.");
    }

    // Step 3: Upsert catalog item
    const targetLookupMode = !!(cat?.target_lookup_sys_id || cat?.target_lookup_name);
    const baseCatalogPayload = {
      short_description: cat.short_description || cat.name,
      active: true,
      availability: "on_both",
      visible_standalone: true,
      hide_sp: false,
      category: categorySysId,
      ...(catalogSysId ? { sc_catalogs: catalogSysId } : {}),
    };

    const createCatalogPayload = {
      name: cat.name,
      ...baseCatalogPayload,
    };

    let catalogItemSysId = await resolveExistingCatalogItemSysId(cat);
    let deploymentMode = "created";

    if (catalogItemSysId) {
      try {
        const updateCatalogPayload = {
          ...baseCatalogPayload,
          // In explicit target mode, avoid accidental renames unless user is updating by artifact identity.
          ...(!targetLookupMode ? { name: cat.name } : {}),
        };

        const patchResp = await client.patch(`/table/sc_cat_item/${catalogItemSysId}`, updateCatalogPayload, {
          headers: updateSetHeaders,
        });
        catalogItemSysId = patchResp.data?.result?.sys_id || catalogItemSysId;
        deploymentMode = "updated";
      } catch (axErr) {
        const status = axErr.response?.status;
        const msg = axErr.response?.data?.error?.message || JSON.stringify(axErr.response?.data).slice(0, 300);
        throw new Error(`sc_cat_item PATCH HTTP ${status}: ${msg}`);
      }
    } else {
      let catResp;
      try {
        catResp = await client.post("/table/sc_cat_item", createCatalogPayload, { headers: updateSetHeaders });
      } catch (axErr) {
        const status = axErr.response?.status;
        const msg = axErr.response?.data?.error?.message || JSON.stringify(axErr.response?.data).slice(0, 300);
        throw new Error(`sc_cat_item POST HTTP ${status}: ${msg}`);
      }

      catalogItemSysId = catResp.data?.result?.sys_id;

      // SN sometimes returns 201 with empty body - look up by name
      if (!catalogItemSysId && (catResp.status === 200 || catResp.status === 201)) {
        const lookup = await client.get(
          `/table/sc_cat_item?sysparm_query=name=${encodeURIComponent(cat.name)}&sysparm_fields=sys_id&sysparm_limit=1`
        );
        catalogItemSysId = lookup.data?.result?.[0]?.sys_id;
      }

      if (!catalogItemSysId) {
        throw new Error(`sc_cat_item creation failed. HTTP ${catResp.status}`);
      }
    }

    console.log(`Catalog item ${deploymentMode}:`, catalogItemSysId);
    deployedIds.catalogItem = catalogItemSysId;

    // Step 4: Create variables
    const variables = artifacts.variableSet?.variables || [];
    const createdVarIds = [];
    console.log(`Variables to create: ${variables.length}`);

    for (let i = 0; i < variables.length; i += 1) {
      const v = variables[i];
      try {
        const upsertedVar = await upsertCatalogVariable(catalogItemSysId, v, i, updateSetHeaders);
        createdVarIds.push(upsertedVar.sys_id);
        variableDetails.push(upsertedVar);
        console.log(`Variable ${upsertedVar.status}: ${upsertedVar.name} (${upsertedVar.sys_id})`);

        const choiceRows = normalizeChoices(v.choices);
        if (choiceRows.length > 0) {
          for (let ci = 0; ci < choiceRows.length; ci += 1) {
            try {
              await client.post(
                "/table/question_choice",
                {
                  question: upsertedVar.sys_id,
                  text: choiceRows[ci].text,
                  value: choiceRows[ci].value,
                  order: ci * 100,
                  inactive: false,
                },
                { headers: updateSetHeaders }
              );
              console.log(`Choice added: ${choiceRows[ci].text}`);
            } catch (ce) {
              warnings.push(`Choice "${choiceRows[ci].text}" for ${upsertedVar.name}: ${ce.response?.data?.error?.message || ce.message}`);
            }
          }
        }
      } catch (err) {
        const variableName = sanitizeVariableName(v.name, i);
        const detail = err.response?.data?.error?.message || err.message;
        console.error(`Variable "${variableName}" failed: ${detail}`);
        warnings.push(`Variable "${variableName}": ${detail}`);
      }
    }

    deployedIds.variables = createdVarIds;

    // Step 5: Create approval rules
    if (artifacts.approval?.approvers?.length > 0) {
      for (const approver of artifacts.approval.approvers) {
        try {
          await client.post(
            "/table/sysapproval_approver",
            {
              name: `Approval_${cat.name}_${approver}`,
              approver,
              source_table: "sc_request",
              state: "requested",
            },
            { headers: updateSetHeaders }
          );
          console.log(`Approval created for: ${approver}`);
        } catch (err) {
          warnings.push(`Approval "${approver}": ${err.response?.data?.error?.message || err.message}`);
        }
      }
      deployedIds.approvals = artifacts.approval.approvers;
    }

    // Step 6: Create Business Rule + Client Script tied to catalog item
    try {
      const scriptContext = {
        name: cat.name,
        variables,
        sla_minutes: Number(cat.sla_minutes) || 480,
      };

      const { businessRuleName, clientScriptName } = buildActionBasedScriptNames(cat.name, variables);
      const brScript = generateBusinessRuleScript(scriptContext);
      const csScript = generateClientScript(scriptContext);

      const brResult = await upsertBusinessRuleForCatalogItem(
        catalogItemSysId,
        businessRuleName,
        brScript,
        updateSetHeaders,
        updateSetId
      );
      deployedIds.businessRule = brResult.sys_id;
      console.log(`Business Rule ${brResult.status}: ${businessRuleName} (${brResult.sys_id})`);

      const csResult = await upsertClientScriptForCatalogItem(
        catalogItemSysId,
        clientScriptName,
        csScript,
        updateSetHeaders,
        updateSetId
      );
      deployedIds.clientScript = csResult.sys_id;
      console.log(`Client Script ${csResult.status}: ${clientScriptName} (${csResult.sys_id})`);
    } catch (scriptErr) {
      const detail = scriptErr.response?.data?.error?.message || scriptErr.message;
      warnings.push(`Scripts: ${detail}`);
    }

    // Step 7: Create ATF test suite + steps
    try {
      const atfName = artifacts.testCase?.name || `ATF_${cat.name.replace(/[^a-zA-Z0-9]/g, "_")}_Test`;

      const atfResp = await client.post(
        "/table/sys_atf_test",
        {
          name: atfName,
          description: `ATF test for catalog item: ${cat.name} (sys_id: ${catalogItemSysId})`,
          active: true,
        },
        { headers: updateSetHeaders }
      );

      const atfSysId = atfResp.data?.result?.sys_id;

      if (atfSysId) {
        console.log("ATF test suite created:", atfSysId);
        deployedIds.atfTest = atfSysId;

        const resolveConfig = await createAtfStepConfigResolver();

        const savedSteps = artifacts.testCase?.test_steps;
        const itemVars = artifacts.variableSet?.variables || [];

        const atfSteps = savedSteps && savedSteps.length > 0
          ? savedSteps.map((s, i) => ({
              order: s.order ?? (i + 1) * 100,
              description: s.description || `Step ${i + 1}`,
              step_config: resolveConfig(s.action),
              action: s.action,
              inputs: JSON.stringify({ action: s.action, description: s.description }),
            }))
          : [
              {
                order: 100,
                description: `Open catalog item: ${cat.name}`,
                step_config: resolveConfig("open_catalog_item"),
                action: "open_catalog_item",
                inputs: JSON.stringify({ catalogItemId: catalogItemSysId }),
              },
              ...itemVars.map((v, i) => ({
                order: (i + 2) * 100,
                description: `Set variable: ${v.label || v.name}`,
                step_config: resolveConfig("fill_variables"),
                action: "fill_variables",
                inputs: JSON.stringify({ field: v.name, value: getSampleTestValue(v) }),
              })),
              {
                order: (itemVars.length + 2) * 100,
                description: "Validate catalog request was created in sc_request",
                step_config: resolveConfig("assert"),
                action: "assert",
                inputs: JSON.stringify({ table: "sc_request", field: "state", value: "1" }),
              },
            ];

        for (const step of atfSteps) {
          try {
            await createAtfStepWithFallback(atfSysId, step, updateSetId);
            console.log(`ATF step created: ${step.description}`);
          } catch (stepErr) {
            warnings.push(`ATF step "${step.description}": ${stepErr.response?.data?.error?.message || stepErr.message}`);
          }
        }

        deployedIds.atf_test_url = `${instanceUrl}/nav_to.do?uri=sys_atf_test.do?sys_id=${atfSysId}`;
      }
    } catch (atfErr) {
      const detail = atfErr.response?.data?.error?.message || atfErr.message;
      console.warn("ATF test creation:", detail);
      warnings.push(`ATF test: ${detail}`);
    }

    // Step 8: Mark update set complete
    try {
      await moveRecentCustomerUpdatesToSet(updateSetId, deploymentStartedAt);
      await client.patch(`/table/sys_update_set/${updateSetId}`, { state: "complete" }, { headers: updateSetHeaders });
      console.log("Update set marked complete");
    } catch (err) {
      warnings.push(`Update set complete: ${err.response?.data?.error?.message || err.message}`);
    }

    console.log("Deployment complete. Catalog item sys_id:", catalogItemSysId);

    return {
      success: true,
      deployment_mode: deploymentMode,
      catalog_item_id: catalogItemSysId,
      update_set_id: updateSetId,
      instance_url: `${instanceUrl}/nav_to.do?uri=sc_cat_item.do?sys_id=${catalogItemSysId}`,
      atf_test_url: deployedIds.atf_test_url || null,
      deployed_ids: deployedIds,
      variable_details: variableDetails,
      warnings,
      deployed_at: new Date().toISOString(),
      message:
        deploymentMode === "updated"
          ? `Catalog item "${cat.name}" successfully updated in ServiceNow`
          : `Catalog item "${cat.name}" successfully deployed to ServiceNow`,
    };
  } catch (err) {
    console.error("Deployment failed:", err.message);
    if (isConnectivityError(err)) {
      const cat = artifacts?.catalogItem || {};
      const localVars = artifacts?.variableSet?.variables || [];
      return {
        success: true,
        deployment_mode: "simulated",
        catalog_item_id: cat.sys_id || `cat_${Math.random().toString(36).slice(2, 11)}`,
        update_set_id: artifacts?.updateSet?.sys_id || `updateset_${Math.random().toString(36).slice(2, 11)}`,
        instance_url: null,
        atf_test_url: null,
        deployed_ids: {
          ...deployedIds,
          catalogItem: deployedIds.catalogItem || cat.sys_id || null,
          variables: deployedIds.variables || localVars.map((v) => v.sys_id).filter(Boolean),
        },
        variable_details: variableDetails.length > 0 ? variableDetails : localVars,
        warnings: [...warnings, `Connectivity issue detected (${err.code || "network"}); deployment simulated.`],
        deployed_at: new Date().toISOString(),
        message: `Catalog item "${cat.name || "Service Request"}" simulated deployment completed`,
      };
    }
    return {
      success: false,
      error: err.message,
      deployed_ids: deployedIds,
      warnings,
    };
  }
}

function getSampleTestValue(variable) {
  if (variable.choices?.length > 0) return variable.choices[0];
  switch (variable.type) {
    case "string":
      return `Test_${variable.name}`;
    case "number":
      return "1";
    case "boolean":
      return "true";
    case "date":
      return new Date().toISOString().split("T")[0];
    case "datetime":
      return new Date().toISOString().replace("T", " ").slice(0, 19);
    case "email":
      return "test@example.com";
    case "url":
      return "https://example.com";
    default:
      return `sample_${variable.name}`;
  }
}

export async function checkInstanceHealth() {
  if (offlineModeByEnv) {
    return { status: "offline_mode", instance: instanceUrl };
  }
  try {
    console.log("Checking instance health at:", instanceUrl);
    await client.get("/table/sys_user?sysparm_limit=1");
    return { status: "healthy", instance: instanceUrl };
  } catch (err) {
    console.error("Instance check failed:", err.message);
    return { status: "unavailable", error: err.message };
  }
}
