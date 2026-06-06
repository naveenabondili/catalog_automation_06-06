import React, { useState } from 'react';
import { API_URL } from '../config';
import TextDiffChecker from './TextDiffChecker';
import DeployModal from './DeployModal';
import UpdateCatalogItemModal from './UpdateCatalogItemModal';
import { useToast } from '../context/ToastContext';

function ArtifactsList({ artifacts, onRefresh, token }) {
  const { addToast } = useToast();
  const [expanded, setExpanded] = useState({});
  const [activeTab, setActiveTab] = useState({});
  const [showDiff, setShowDiff] = useState(false);
  const [deployModalArtifact, setDeployModalArtifact] = useState(null);
  const [updateModalArtifact, setUpdateModalArtifact] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [cloning, setCloning] = useState({});

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  // ── Clone ─────────────────────────────────────────────────────────────────
  const handleClone = async (requirementId) => {
    setCloning(c => ({ ...c, [requirementId]: true }));
    try {
      const res = await fetch(`${API_URL}/artifacts/${requirementId}/clone`, {
        method: 'POST', headers: authHeaders,
      });
      const data = await res.json();
      if (data.success) {
        addToast(`📋 Cloned as "${data.name}"`, 'success');
        onRefresh();
      } else {
        addToast(`❌ Clone failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addToast(`❌ ${err.message}`, 'error');
    } finally {
      setCloning(c => ({ ...c, [requirementId]: false }));
    }
  };

  // ── Export JSON ───────────────────────────────────────────────────────────
  const handleExport = (artifact) => {
    const arts = typeof artifact.artifacts === 'string'
      ? JSON.parse(artifact.artifacts) : artifact.artifacts;
    const blob = new Blob([JSON.stringify({ ...artifact, artifacts: arts }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(arts?.catalogItem?.name || 'artifact').replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('📥 JSON exported', 'info');
  };

  // ── Filter ────────────────────────────────────────────────────────────────
  const displayed = artifacts.filter(a => {
    const arts = typeof a.artifacts === 'string' ? JSON.parse(a.artifacts) : (a.artifacts || {});
    const matchSearch = !search ||
      a.name?.toLowerCase().includes(search.toLowerCase()) ||
      a.requirement_id?.toLowerCase().includes(search.toLowerCase());
    const isDeployed = arts?.flow?.status === 'created_in_sn' || arts?.catalogItem?.status === 'created_in_sn';
    const matchStatus =
      statusFilter === 'all' ? true :
      statusFilter === 'deployed' ? isDeployed :
      statusFilter === 'local' ? !isDeployed : true;
    return matchSearch && matchStatus;
  });

  const handleScopedDeploy = async (requirementId) => {
    if (!token) { addToast('Please log in to deploy as scoped app.', 'warning'); return; }
    if (!window.confirm('Deploy as Scoped Application?')) return;
    try {
      const response = await fetch(`${API_URL}/deploy/${requirementId}/scoped`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (data.success) addToast(`✅ Scoped App created: ${data.scopedApp?.scope || data.scopedApp?.name}`, 'success');
      else addToast(`❌ Scoped App failed: ${data.error}`, 'error');
    } catch (err) {
      addToast(`❌ ${err.message}`, 'error');
    }
  };

  const toggleExpand = (id) => {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
    setActiveTab((t) => ({ ...t, [id]: t[id] || 'variables' }));
  };

  const setTab = (id, tab) => setActiveTab((t) => ({ ...t, [id]: tab }));

  const getBadges = (artifact) => {
    try {
      const arts = typeof artifact.artifacts === 'string' ? JSON.parse(artifact.artifacts) : artifact.artifacts;
      const badges = [];
      const varCount = arts?.variableSet?.variables?.length || 0;
      if (varCount) badges.push({ label: `${varCount} vars`, color: '#4a90d9' });
      if (arts?.flow) badges.push({ label: 'flow', color: '#8e44ad' });
      if (arts?.approval) badges.push({ label: 'approval', color: '#e67e22' });
      if (arts?.businessRule) badges.push({ label: 'BR', color: '#16a085' });
      if (arts?.clientScript) badges.push({ label: 'CS', color: '#2980b9' });
      const testStatus = arts?.testResult?.status;
      if (testStatus) badges.push({ label: `ATF: ${testStatus}`, color: testStatus === 'passed' ? '#27ae60' : '#e74c3c' });
      return badges;
    } catch { return []; }
  };

  return (
    <div className="card">
      {showDiff && <TextDiffChecker onClose={() => setShowDiff(false)} />}
      {deployModalArtifact && (
        <DeployModal
          artifact={deployModalArtifact}
          token={token}
          onClose={() => setDeployModalArtifact(null)}
          onDeployed={() => { setDeployModalArtifact(null); onRefresh(); }}
        />
      )}
      {updateModalArtifact && (
        <UpdateCatalogItemModal
          artifact={updateModalArtifact}
          token={token}
          onClose={() => setUpdateModalArtifact(null)}
          onUpdated={() => { setUpdateModalArtifact(null); onRefresh(); }}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h2 style={{ margin: 0 }}>📦 Artifacts <span style={{ fontSize: '13px', color: '#aaa', fontWeight: 'normal' }}>({displayed.length}/{artifacts.length})</span></h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={() => setShowDiff(true)} className="btn-small" style={{ background: '#4a90d9', color: '#fff', border: 'none' }}>🔀 Compare</button>
          <button onClick={onRefresh} className="btn-small">🔄 Refresh</button>
        </div>
      </div>

      {/* Search + Filter bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search by name or ID…"
          style={{ flex: 1, minWidth: '160px', padding: '7px 10px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '6px' }}
        />
        {['all', 'deployed', 'local'].map(f => (
          <button key={f} onClick={() => setStatusFilter(f)}
            style={{
              padding: '6px 12px', fontSize: '11px', borderRadius: '14px', cursor: 'pointer',
              border: `2px solid ${statusFilter === f ? '#667eea' : '#ddd'}`,
              background: statusFilter === f ? '#667eea' : '#fff',
              color: statusFilter === f ? '#fff' : '#666', fontWeight: '600',
            }}>
            {f === 'all' ? 'All' : f === 'deployed' ? '🚀 Deployed' : '📦 Local'}
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#aaa', padding: '20px' }}>
          {artifacts.length === 0 ? 'No artifacts yet. Submit a requirement to get started.' : 'No artifacts match your search.'}
        </p>
      ) : (
        <ul className="artifact-list">
          {displayed.map((artifact) => {
            const id = artifact.requirement_id;
            const isExpanded = expanded[id];
            const tab = activeTab[id] || 'variables';
            const badges = getBadges(artifact);

            return (
              <li key={id} className="artifact-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h4 style={{ margin: '0 0 4px' }}>{artifact.name}</h4>
                    <p style={{ margin: '0 0 4px', fontSize: '11px', color: '#aaa', fontFamily: 'monospace' }}>
                      {id}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' }}>
                      {badges.map((b, i) => (
                        <span key={i} style={{
                          background: b.color, color: '#fff', fontSize: '11px',
                          padding: '1px 7px', borderRadius: '10px', fontWeight: '600'
                        }}>{b.label}</span>
                      ))}
                    </div>
                    <p style={{ margin: 0, fontSize: '11px', color: '#888' }}>
                      <span className={`status-badge status-${artifact.status}`}>{artifact.status || 'generated'}</span>
                      {' · '}{new Date(artifact.created_at).toLocaleString()}
                    </p>
                  </div>
                  <button className="btn-small" onClick={() => toggleExpand(id)} style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                    {isExpanded ? '▲ Less' : '▼ Details'}
                  </button>
                </div>

                {isExpanded && (
                  <ArtifactDetails artifact={artifact} tab={tab} onTabChange={(t) => setTab(id, t)} />
                )}

                <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button className="btn-small"
                    onClick={() => setDeployModalArtifact(artifact)}
                    style={{ background: '#e74c3c', color: '#fff', fontWeight: '600' }}>
                    🚀 Review &amp; Deploy
                  </button>
                  <button className="btn-small"
                    onClick={() => setUpdateModalArtifact(artifact)}
                    style={{ background: '#667eea', color: '#fff', fontWeight: '600' }}>
                    ✏️ Edit / Update
                  </button>
                  <button className="btn-small"
                    onClick={() => handleClone(id)} disabled={cloning[id]}
                    style={{ background: '#16a085', color: '#fff' }}>
                    {cloning[id] ? '⏳' : '📋 Clone'}
                  </button>
                  <button className="btn-small"
                    onClick={() => handleExport(artifact)}
                    style={{ background: '#2980b9', color: '#fff' }}>
                    📥 Export JSON
                  </button>
                  <a href={`${API_URL}/report/${id}`} className="btn-small" target="_blank" rel="noreferrer"
                    style={{ background: '#555', color: '#fff' }}>
                    📄 PDF
                  </a>
                  <button className="btn-small" onClick={() => handleScopedDeploy(id)}
                    style={{ background: '#6f42c1', color: '#fff' }}>
                    📦 Scoped
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ArtifactDetails({ artifact, tab, onTabChange }) {
  let arts = {};
  try {
    arts = typeof artifact.artifacts === 'string' ? JSON.parse(artifact.artifacts) : (artifact.artifacts || {});
  } catch {}

  const tabs = [
    { id: 'variables', label: `📝 Variables (${arts.variableSet?.variables?.length || 0})` },
    { id: 'flow', label: '🔄 Flow Designer' },
    { id: 'overview', label: '📋 Overview' },
    { id: 'scripts', label: '⚙️ Scripts' },
    { id: 'testing', label: '🧪 Testing' },
  ];

  return (
    <div style={{ marginTop: '12px', border: '1px solid #e0e0e0', borderRadius: '8px', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', background: '#f5f5f5', borderBottom: '1px solid #e0e0e0', overflowX: 'auto' }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => onTabChange(t.id)} style={{
            padding: '8px 14px', border: 'none', background: tab === t.id ? '#fff' : 'transparent',
            borderBottom: tab === t.id ? '2px solid #4a90d9' : '2px solid transparent',
            cursor: 'pointer', fontSize: '12px', fontWeight: tab === t.id ? '600' : 'normal',
            color: tab === t.id ? '#4a90d9' : '#666', whiteSpace: 'nowrap',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '14px', background: '#fff' }}>
        {tab === 'variables' && <VariablesTab vars={arts.variableSet} />}
        {tab === 'flow' && <FlowDesignerTab flow={arts.flow} approval={arts.approval} />}
        {tab === 'overview' && <OverviewTab arts={arts} />}
        {tab === 'scripts' && <ScriptsTab br={arts.businessRule} cs={arts.clientScript} />}
        {tab === 'testing' && <TestingTab testCase={arts.testCase} testResult={arts.testResult} />}
      </div>
    </div>
  );
}

// ── Variables Tab ────────────────────────────────────────────────────────────

function VariablesTab({ vars }) {
  if (!vars?.variables?.length) {
    return <p style={{ color: '#888', fontSize: '13px' }}>No variables defined for this catalog item.</p>;
  }

  const typeLabels = {
    '1': 'String', '2': 'Number', '3': 'Boolean', '4': 'DateTime',
    '5': 'Date', '8': 'Reference', '18': 'Choice', '19': 'Multi-line',
    '20': 'URL', '21': 'Email',
    string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date',
    datetime: 'DateTime', reference: 'Reference', choice: 'Choice',
    multiline: 'Multi-line', url: 'URL', email: 'Email',
  };

  return (
    <div>
      <p style={{ margin: '0 0 10px', fontSize: '12px', color: '#888' }}>
        {vars.variables.length} variable{vars.variables.length !== 1 ? 's' : ''} · Set: <code style={codeStyle}>{vars.sys_id}</code>
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr style={{ background: '#f0f4f8' }}>
            <th style={thS}>Name</th>
            <th style={thS}>Label</th>
            <th style={thS}>Type</th>
            <th style={thS}>Mandatory</th>
            <th style={thS}>Choices / Reference</th>
          </tr>
        </thead>
        <tbody>
          {vars.variables.map((v, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
              <td style={tdS}><code style={codeStyle}>{v.name}</code></td>
              <td style={tdS}>{v.label || v.name}</td>
              <td style={tdS}>
                <span style={{
                  background: typeColor(v.type), color: '#fff',
                  padding: '1px 7px', borderRadius: '10px', fontSize: '11px'
                }}>
                  {typeLabels[v.type] || v.type || 'String'}
                </span>
              </td>
              <td style={{ ...tdS, textAlign: 'center' }}>
                {v.mandatory ? '✅' : '—'}
              </td>
              <td style={tdS}>
                {v.choices?.length
                  ? v.choices.join(' / ')
                  : v.referenceTable
                  ? <span style={{ color: '#8e44ad' }}>→ {v.referenceTable}</span>
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function typeColor(type) {
  const map = {
    string: '#2980b9', '1': '#2980b9',
    number: '#16a085', '2': '#16a085',
    boolean: '#8e44ad', '3': '#8e44ad',
    date: '#e67e22', '5': '#e67e22',
    datetime: '#d35400', '4': '#d35400',
    reference: '#c0392b', '8': '#c0392b',
    choice: '#27ae60', '18': '#27ae60',
    multiline: '#7f8c8d', '19': '#7f8c8d',
    url: '#2471a3', '20': '#2471a3',
    email: '#1a5276', '21': '#1a5276',
  };
  return map[type] || '#888';
}

// ── Flow Designer Tab ────────────────────────────────────────────────────────

function FlowDesignerTab({ flow, approval }) {
  if (!flow) {
    return <p style={{ color: '#888', fontSize: '13px' }}>No flow defined for this artifact.</p>;
  }

  const steps = flow.steps || [];
  const trigger = flow.trigger || {};
  return (
    <div>
      {flow.status === 'created_in_sn' && (
        flow.automated
          ? (
            <div style={{ marginBottom: '14px', padding: '12px 14px', background: '#e8f5e9', border: '1px solid #66bb6a', borderRadius: '8px', fontSize: '12px' }}>
              <div style={{ fontWeight: '700', color: '#2e7d32', marginBottom: '4px' }}>✅ Flow pre-configured — trigger + actions ready</div>
              <div style={{ color: '#555', marginBottom: '6px' }}>Open in Flow Designer, review the trigger and actions, then click <strong>Activate</strong> to start automation.</div>
              <div style={{ display: 'flex', gap: '12px' }}>
                {flow.flow_designer_url && (
                  <a href={flow.flow_designer_url} target="_blank" rel="noreferrer" style={{ color: '#1565c0', fontWeight: '600' }}>🔄 Open in Flow Designer →</a>
                )}
                {flow.flow_record_url && (
                  <a href={flow.flow_record_url} target="_blank" rel="noreferrer" style={{ color: '#888', fontSize: '11px' }}>📋 Flow Record</a>
                )}
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: '14px', padding: '12px 14px', background: '#fff8e1', border: '1px solid #f9a825', borderRadius: '8px' }}>
              <div style={{ fontWeight: '700', fontSize: '13px', marginBottom: '8px' }}>⚠️ 2 Manual Steps Required in ServiceNow</div>
              <div style={{ fontSize: '12px', lineHeight: '1.8', color: '#555' }}>
                <div style={{ marginBottom: '4px' }}>
                  <strong>Step 1:</strong> {flow.flow_designer_url
                    ? <a href={flow.flow_designer_url} target="_blank" rel="noreferrer" style={{ color: '#1565c0' }}>Open flow in Flow Designer →</a>
                    : <span>Open Flow Designer → find <strong>{flow.name}</strong></span>}
                </div>
                <div style={{ marginBottom: '4px' }}>
                  <strong>Step 2:</strong> Add trigger → <strong>Service Catalog</strong> → table: <code style={codeStyle}>sc_req_item</code>
                </div>
                {steps.length > 0 && <div><strong>Step 3:</strong> Add actions for each step listed below</div>}
              </div>
            </div>
          )
      )}

      <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong style={{ fontSize: '13px' }}>{flow.name}</strong>
          <span style={{ marginLeft: '8px', fontSize: '11px', color: flow.status === 'created_in_sn' ? '#27ae60' : '#e67e22' }}>
            ● {flow.status === 'created_in_sn' ? 'Created in ServiceNow (inactive — open to configure)' : 'Generated locally'}
          </span>
        </div>
        {flow.sys_id && <code style={{ ...codeStyle, fontSize: '10px' }}>{flow.sys_id}</code>}
      </div>

      {/* Visual flow diagram */}
      <div style={{ overflowX: 'auto', paddingBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0', minWidth: 'max-content' }}>

          {/* Trigger node */}
          <FlowNode
            icon="⚡"
            label="Trigger"
            sublabel={trigger.label || `${trigger.event || 'insert'} on ${trigger.table || 'sc_request'}`}
            color="#e67e22"
          />

          {steps.map((step, i) => (
            <React.Fragment key={i}>
              <FlowArrow />
              <FlowNode
                icon={step.type === 'approval' ? '✅' : step.type === 'notification' ? '📧' : '⚙️'}
                label={step.label || step.name}
                sublabel={`Step ${i + 1} · ${step.type || 'action'}`}
                color={step.type === 'approval' ? '#8e44ad' : step.type === 'notification' ? '#2980b9' : '#16a085'}
              />
            </React.Fragment>
          ))}

          {approval && (
            <>
              <FlowArrow />
              <FlowNode
                icon="👤"
                label="Approval"
                sublabel={approval.approvers?.join(', ') || 'Pending approval'}
                color="#c0392b"
              />
            </>
          )}

          <FlowArrow />
          <FlowNode icon="🏁" label="End" sublabel="Flow complete" color="#7f8c8d" />
        </div>
      </div>

      {/* Step details table */}
      {steps.length > 0 && (
        <div style={{ marginTop: '14px' }}>
          <p style={{ fontSize: '12px', fontWeight: '600', margin: '0 0 6px', color: '#555' }}>
            Flow Steps ({steps.length})
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: '#f0f4f8' }}>
                <th style={thS}>Order</th>
                <th style={thS}>Step Name</th>
                <th style={thS}>Type</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ ...tdS, textAlign: 'center', color: '#888' }}>{step.order ?? i * 100}</td>
                  <td style={tdS}>{step.label || step.name}</td>
                  <td style={tdS}>
                    <span style={{
                      background: step.type === 'approval' ? '#8e44ad' : step.type === 'notification' ? '#2980b9' : '#16a085',
                      color: '#fff', padding: '1px 7px', borderRadius: '10px', fontSize: '11px'
                    }}>
                      {step.type || 'action'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {approval && (
        <div style={{ marginTop: '12px', padding: '10px', background: '#fdf6ff', border: '1px solid #d5b8f5', borderRadius: '6px', fontSize: '12px' }}>
          <strong>👤 Approval Rule</strong>
          <div style={{ marginTop: '4px', color: '#555' }}>
            <span style={{ marginRight: '16px' }}>Approvers: <strong>{approval.approvers?.join(', ') || '—'}</strong></span>
            {approval.approverGroups?.length > 0 && (
              <span style={{ marginRight: '16px' }}>Groups: <strong>{approval.approverGroups.join(', ')}</strong></span>
            )}
            {approval.condition && approval.condition !== 'active=true' && (
              <span>Condition: <code style={codeStyle}>{approval.condition}</code></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FlowNode({ icon, label, sublabel, color }) {
  return (
    <div style={{
      minWidth: '110px', maxWidth: '130px', border: `2px solid ${color}`,
      borderRadius: '8px', padding: '8px 10px', textAlign: 'center',
      background: `${color}18`, position: 'relative',
    }}>
      <div style={{ fontSize: '20px', lineHeight: 1 }}>{icon}</div>
      <div style={{ fontSize: '11px', fontWeight: '700', color, marginTop: '4px', wordBreak: 'break-word' }}>{label}</div>
      {sublabel && <div style={{ fontSize: '10px', color: '#888', marginTop: '2px', wordBreak: 'break-word' }}>{sublabel}</div>}
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '0 2px' }}>
      <div style={{ width: '24px', height: '2px', background: '#ccc' }} />
      <div style={{ borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderLeft: '8px solid #ccc' }} />
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ arts }) {
  const rows = [
    { label: '📋 Catalog Item', data: arts.catalogItem, fields: ['sys_id', 'name', 'status', 'availability'] },
    { label: '📦 Update Set', data: arts.updateSet, fields: ['sys_id', 'name', 'status'] },
    { label: '✅ Approval', data: arts.approval, fields: ['sys_id', 'name', 'condition', 'status'] },
  ];

  return (
    <div style={{ fontSize: '12px' }}>
      {rows.map(({ label, data, fields }) => data ? (
        <div key={label} style={{ marginBottom: '10px', padding: '8px', background: '#f8f8f8', borderRadius: '6px' }}>
          <strong>{label}</strong>
          <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '12px', color: '#555' }}>
            {fields.map((f) => data[f] != null && (
              <span key={f}>{f}: <code style={codeStyle}>{Array.isArray(data[f]) ? data[f].join(', ') : String(data[f])}</code></span>
            ))}
          </div>
        </div>
      ) : null)}
    </div>
  );
}

// ── Scripts Tab ──────────────────────────────────────────────────────────────

function ScriptsTab({ br, cs }) {
  if (!br && !cs) {
    return <p style={{ color: '#888', fontSize: '13px' }}>No scripts generated for this artifact.</p>;
  }
  return (
    <div>
      {br && (
        <div style={{ marginBottom: '14px' }}>
          <p style={{ margin: '0 0 6px', fontWeight: '700', fontSize: '13px' }}>
            ⚙️ Business Rule — <span style={{ fontWeight: 'normal', color: '#888' }}>{br.name}</span>
          </p>
          <pre style={preStyle}>{br.script || '// no script content'}</pre>
        </div>
      )}
      {cs && (
        <div>
          <p style={{ margin: '0 0 6px', fontWeight: '700', fontSize: '13px' }}>
            💻 Client Script — <span style={{ fontWeight: 'normal', color: '#888' }}>{cs.name}</span>
          </p>
          <pre style={preStyle}>{cs.script || '// no script content'}</pre>
        </div>
      )}
    </div>
  );
}

// ── Testing Tab ──────────────────────────────────────────────────────────────

function TestingTab({ testCase, testResult }) {
  if (!testCase && !testResult) {
    return <p style={{ color: '#888', fontSize: '13px' }}>No ATF test data for this artifact.</p>;
  }

  const statusColor = { passed: '#27ae60', failed: '#e74c3c', timeout: '#e67e22', pending: '#888' };

  return (
    <div style={{ fontSize: '12px' }}>
      {testResult && (
        <div style={{
          marginBottom: '12px', padding: '10px 14px',
          background: statusColor[testResult.status] + '18',
          border: `1px solid ${statusColor[testResult.status] || '#ccc'}`,
          borderRadius: '8px',
        }}>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <span>Status: <strong style={{ color: statusColor[testResult.status] }}>
              {testResult.status?.toUpperCase() || 'UNKNOWN'}
            </strong></span>
            <span>Steps passed: <strong>{testResult.steps_passed ?? '—'}</strong></span>
            <span>Steps failed: <strong>{testResult.steps_failed ?? '—'}</strong></span>
            <span>Duration: <strong>{testResult.duration_ms ? `${testResult.duration_ms}ms` : '—'}</strong></span>
            <span>Mode: <strong>{testResult.mode || '—'}</strong></span>
          </div>
          {testResult.results && (
            <p style={{ margin: '6px 0 0', color: '#555' }}>{testResult.results}</p>
          )}
        </div>
      )}

      {testCase?.test_steps?.length > 0 && (
        <div>
          <p style={{ fontWeight: '700', margin: '0 0 6px' }}>Test Steps ({testCase.test_steps.length})</p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f0f4f8' }}>
                <th style={thS}>#</th>
                <th style={thS}>Action</th>
                <th style={thS}>Description</th>
              </tr>
            </thead>
            <tbody>
              {testCase.test_steps.map((s, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ ...tdS, textAlign: 'center', color: '#888' }}>{s.order ?? i + 1}</td>
                  <td style={tdS}><code style={codeStyle}>{s.action}</code></td>
                  <td style={tdS}>{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const thS = { padding: '6px 10px', textAlign: 'left', fontWeight: '600', fontSize: '11px', color: '#555' };
const tdS = { padding: '5px 10px', verticalAlign: 'top' };
const codeStyle = { background: '#eef', padding: '1px 5px', borderRadius: '3px', fontFamily: 'monospace', fontSize: '11px' };
const preStyle = {
  background: '#1e1e1e', color: '#d4d4d4', padding: '12px', borderRadius: '6px',
  fontSize: '11px', overflowX: 'auto', maxHeight: '250px', margin: 0, fontFamily: 'monospace',
};

export default ArtifactsList;