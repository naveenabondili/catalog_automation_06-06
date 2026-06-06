import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const openRouterKey = process.env.OPENROUTER_API_KEY;
const MODEL = "meta-llama/llama-3.3-70b-instruct";
const openRouterTimeoutMs = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || "60000", 10) || 60000;
const disableRemoteAiByEnv = process.env.DISABLE_REMOTE_AI === "true";
let remoteAiUnavailableForProcess = disableRemoteAiByEnv;

function isConnectivityError(err) {
  const code = err?.code || "";
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ECONNABORTED"].includes(code);
}

export async function interpretWithGemini(text) {
  if (!openRouterKey) {
    console.warn("⚠️  OpenRouter API key not configured, using fallback interpreter");
    return interpretWithFallback(text);
  }

  if (remoteAiUnavailableForProcess) {
    console.log("ℹ️  Remote AI disabled/unavailable; using fallback interpreter.");
    return interpretWithFallback(text);
  }

  try {
    console.log(`🧠 Using OpenRouter (${MODEL}) for interpretation...`);

    const prompt = `You are a ServiceNow expert. Analyze this requirement and extract a complete catalog item configuration as JSON.

Requirement: "${text}"

Return ONLY valid JSON (no markdown, no extra text, no code blocks):
{
  "name": "Descriptive Item Name",
  "description": "What this request does",
  "category": "IT Services",
  "variables": [
    {
      "name": "variable_name",
      "type": "string",
      "label": "User-Friendly Label",
      "mandatory": true,
      "choices": [],
      "referenceTable": ""
    }
  ],
  "approvals": ["manager"],
  "approvalGroups": ["it_helpdesk"],
  "approvalConditions": [
    { "field": "urgency", "operator": "=", "value": "1" }
  ],
  "workflow": ["submit", "manager_approval", "fulfillment", "complete"],
  "sla_minutes": 480,
  "scripts": {
    "businessRule": true,
    "clientScript": true
  },
  "flowTrigger": {
    "table": "sc_request",
    "event": "insert",
    "condition": "active=true"
  }
}

Variable types allowed: string, choice, number, boolean, date, datetime, reference, url, email, multiline
Approval roles allowed: manager, security, it, director, finance
Include approvalConditions only when the requirement mentions conditional logic (e.g., "only if cost > 500").
Include approvalGroups when group-level approval is mentioned.`;

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: "You are a ServiceNow automation expert. Always respond with valid JSON only, no markdown or extra text." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      },
      {
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3001",
          "X-Title": "ServiceNow AI Automation",
        },
        timeout: openRouterTimeoutMs,
      }
    );

    let content = response.data.choices[0].message.content;
    console.log("🔍 OpenRouter response received, extracting JSON...");

    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let result;
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("❌ No JSON found in OpenRouter response, falling back");
        return interpretWithFallback(text);
      }
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch {
        console.error("❌ Extracted JSON still invalid, falling back");
        return interpretWithFallback(text);
      }
    }

    // Validate and clean result
    if (!result.name) result.name = "Service Request";
    if (!result.description) result.description = text;
    if (!Array.isArray(result.variables)) result.variables = [];
    if (!Array.isArray(result.approvals)) result.approvals = ["manager"];
    if (!Array.isArray(result.approvalGroups)) result.approvalGroups = [];
    if (!Array.isArray(result.approvalConditions)) result.approvalConditions = [];
    if (!Array.isArray(result.workflow)) result.workflow = ["submit", "manager_approval", "fulfillment", "complete"];
    if (!result.sla_minutes) result.sla_minutes = 480;
    if (!result.category) result.category = "IT Services";
    if (!result.scripts) result.scripts = { businessRule: true, clientScript: true };
    if (!result.flowTrigger) result.flowTrigger = { table: "sc_request", event: "insert", condition: "active=true" };

    result.variables = result.variables.map((v) => ({
      name: (v.name || "field").replace(/\s+/g, "_").toLowerCase(),
      type: v.type || "string",
      label: v.label || v.name || "Field",
      mandatory: v.mandatory !== false,
      choices: Array.isArray(v.choices) ? v.choices : [],
      referenceTable: v.referenceTable || "",
    }));

    const validApprovals = ["manager", "security", "it", "director", "finance"];
    result.approvals = result.approvals
      .map((a) => a.toString().toLowerCase())
      .filter((a) => validApprovals.includes(a));
    if (result.approvals.length === 0) result.approvals = ["manager"];

    console.log(`✅ OpenRouter (${MODEL}) interpretation successful`);
    console.log("   Name:", result.name);
    console.log("   Variables:", result.variables.length);
    console.log("   Approvals:", result.approvals.join(", "));

    return {
      type: "catalog_item",
      name: result.name,
      description: result.description,
      category: result.category,
      variables: result.variables,
      approvals: result.approvals,
      approvalGroups: result.approvalGroups,
      approvalConditions: result.approvalConditions,
      workflow: result.workflow,
      sla_minutes: result.sla_minutes,
      scripts: result.scripts,
      flowTrigger: result.flowTrigger,
    };
  } catch (err) {
    console.error("❌ OpenRouter interpretation failed:", err.message);
    if (err.response?.data?.error) {
      console.error("   Error:", JSON.stringify(err.response.data.error));
    }
    if (isConnectivityError(err)) {
      remoteAiUnavailableForProcess = true;
      console.warn("⚠️  Disabling remote AI for this process due to connectivity errors.");
    }
    return interpretWithFallback(text);
  }
}

function interpretWithFallback(text) {
  console.log("📋 Using fallback rule-based interpreter");

  const lower = text.toLowerCase();
  let name = "Service Request";
  let category = "IT Services";

  if (lower.includes("laptop")) { name = "Laptop Request"; category = "Hardware"; }
  else if (lower.includes("password")) { name = "Password Reset"; category = "Access Management"; }
  else if (lower.includes("access")) { name = "Access Request"; category = "Access Management"; }
  else if (lower.includes("phone")) { name = "Phone Request"; category = "Hardware"; }
  else if (lower.includes("software")) { name = "Software License"; category = "Software"; }
  else if (lower.includes("vpn")) { name = "VPN Access"; category = "Network"; }
  else if (lower.includes("hardware")) { name = "Hardware Request"; category = "Hardware"; }
  else if (lower.includes("email")) { name = "Email Account"; category = "Communication"; }

  let approvals = [];
  if (lower.includes("manager")) approvals.push("manager");
  if (lower.includes("security")) approvals.push("security");
  if (lower.includes("it") || lower.includes("fulfillment")) approvals.push("it");
  if (lower.includes("director")) approvals.push("director");
  if (lower.includes("finance")) approvals.push("finance");
  if (approvals.length === 0) approvals = ["manager"];

  const approvalConditions = [];
  if (lower.includes("if cost") || lower.includes("over $") || lower.includes("above $")) {
    approvalConditions.push({ field: "cost", operator: ">", value: "500" });
  }
  if (lower.includes("high priority") || lower.includes("urgent")) {
    approvalConditions.push({ field: "urgency", operator: "=", value: "1" });
  }

  const approvalGroups = [];
  if (lower.includes("helpdesk") || lower.includes("help desk")) approvalGroups.push("it_helpdesk");
  if (lower.includes("security team")) approvalGroups.push("security_team");

  let variables = [];
  if (name.includes("Laptop")) {
    variables = [
      { name: "model", type: "choice", label: "Laptop Model", mandatory: true, choices: ["Dell", "HP", "Lenovo", "MacBook"], referenceTable: "" },
      { name: "ram", type: "choice", label: "RAM Size", mandatory: true, choices: ["8GB", "16GB", "32GB"], referenceTable: "" },
      { name: "justification", type: "multiline", label: "Business Justification", mandatory: true, choices: [], referenceTable: "" },
      { name: "os_preference", type: "choice", label: "OS Preference", mandatory: false, choices: ["Windows", "Mac", "Linux"], referenceTable: "" },
      { name: "urgency", type: "choice", label: "Urgency", mandatory: true, choices: ["Low", "Medium", "High"], referenceTable: "" },
    ];
  } else if (name.includes("Password")) {
    variables = [
      { name: "system", type: "choice", label: "System", mandatory: true, choices: ["Active Directory", "Email", "VPN", "Database"], referenceTable: "" },
    ];
    approvals = [];
  } else if (name.includes("Access")) {
    variables = [
      { name: "system", type: "string", label: "System/Application", mandatory: true, choices: [], referenceTable: "" },
      { name: "access_level", type: "choice", label: "Access Level", mandatory: true, choices: ["Read", "Write", "Admin"], referenceTable: "" },
      { name: "duration", type: "choice", label: "Duration", mandatory: true, choices: ["1 Week", "1 Month", "3 Months", "Permanent"], referenceTable: "" },
    ];
  } else {
    variables = [
      { name: "description", type: "multiline", label: "Description", mandatory: true, choices: [], referenceTable: "" },
      { name: "urgency", type: "choice", label: "Urgency", mandatory: true, choices: ["Low", "Medium", "High"], referenceTable: "" },
    ];
  }

  return {
    type: "catalog_item",
    name,
    description: text,
    category,
    variables,
    approvals,
    approvalGroups,
    approvalConditions,
    workflow: ["submit", ...approvals.map((a) => `${a}_approval`), "fulfillment", "complete"],
    sla_minutes: approvals.length > 0 ? 480 : 120,
    scripts: { businessRule: true, clientScript: true },
    flowTrigger: { table: "sc_request", event: "insert", condition: "active=true" },
  };
}
