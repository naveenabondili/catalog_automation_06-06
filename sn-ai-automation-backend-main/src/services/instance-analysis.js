import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../../.env") });

const instanceUrl = process.env.SN_INSTANCE_URL;
const user = process.env.SN_USER;
const pass = process.env.SN_PASS;

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

// BR-03.1: Fetch existing catalog items
export async function fetchCatalogItems(limit = 100) {
  if (!snClient) throw new Error("ServiceNow client not initialized");
  const resp = await snClient.get(
    `/table/sc_cat_item?sysparm_limit=${limit}&sysparm_fields=sys_id,name,short_description,active,category`
  );
  return resp.data.result || [];
}

// BR-03.2: Fetch tables and their fields
export async function fetchTableFields(tableName) {
  if (!snClient) throw new Error("ServiceNow client not initialized");
  const resp = await snClient.get(
    `/table/sys_dictionary?sysparm_query=name=${tableName}&sysparm_fields=element,column_label,internal_type,mandatory`
  );
  return resp.data.result || [];
}

// BR-03.3: Fetch existing workflows/flows
export async function fetchWorkflows(limit = 50) {
  if (!snClient) throw new Error("ServiceNow client not initialized");
  const resp = await snClient.get(
    `/table/sys_hub_flow?sysparm_limit=${limit}&sysparm_fields=sys_id,name,description,active`
  );
  return resp.data.result || [];
}

// BR-03.4: Detect duplicate catalog items by name
export async function detectDuplicate(name) {
  if (!snClient) throw new Error("ServiceNow client not initialized");
  const encoded = encodeURIComponent(`nameLIKE${name}`);
  const resp = await snClient.get(
    `/table/sc_cat_item?sysparm_query=${encoded}&sysparm_fields=sys_id,name&sysparm_limit=5`
  );
  const results = resp.data.result || [];
  const exact = results.filter(
    (r) => r.name.toLowerCase() === name.toLowerCase()
  );
  return {
    isDuplicate: exact.length > 0,
    matches: results,
    exactMatch: exact[0] || null,
  };
}

// Full instance analysis combining all checks
export async function analyzeInstance(catalogItemName) {
  const analysis = {
    catalogItems: [],
    workflows: [],
    duplicate: null,
    tables: {},
    timestamp: new Date().toISOString(),
  };

  try {
    const [catalogItems, workflows, duplicate] = await Promise.all([
      fetchCatalogItems().catch(() => []),
      fetchWorkflows().catch(() => []),
      detectDuplicate(catalogItemName).catch(() => ({ isDuplicate: false, matches: [] })),
    ]);

    analysis.catalogItems = catalogItems;
    analysis.workflows = workflows;
    analysis.duplicate = duplicate;

    // Fetch key table fields for sc_cat_item
    try {
      analysis.tables.sc_cat_item = await fetchTableFields("sc_cat_item");
    } catch {
      analysis.tables.sc_cat_item = [];
    }
  } catch (err) {
    console.error("Instance analysis partial failure:", err.message);
  }

  return analysis;
}
