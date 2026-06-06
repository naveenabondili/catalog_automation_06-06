import React, { useState } from 'react';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';

const VAR_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'multiline', label: 'Multi-line Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date/Time' },
  { value: 'choice', label: 'Choice' },
  { value: 'reference', label: 'Reference' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
];

export default function UpdateCatalogItemModal({ artifact, token, onClose, onUpdated }) {
  const { addToast } = useToast();
  const [mode, setMode] = useState('fields');
  const [saving, setSaving] = useState(false);

  const arts = typeof artifact.artifacts === 'string'
    ? JSON.parse(artifact.artifacts) : (artifact.artifacts || {});

  // Edit Fields state
  const [name, setName] = useState(arts.catalogItem?.name || artifact.name || '');
  const [description, setDescription] = useState(arts.catalogItem?.short_description || '');
  const [variables, setVariables] = useState(
    (arts.variableSet?.variables || []).map(v => ({ ...v }))
  );

  // Requirement re-run state
  const [reqText, setReqText] = useState('');
  const [useAI, setUseAI] = useState(true);

  const authHeaders = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
  };

  const handleSaveFields = async () => {
    if (!name.trim()) { addToast('Catalog item name is required', 'error'); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/artifacts/${artifact.requirement_id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          catalogItem: {
            name: name.trim(),
            short_description: description.trim(),
          },
          variableSet: { variables },
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast(`"${name.trim()}" updated successfully`, 'success');
        onUpdated();
        onClose();
      } else {
        addToast(`Update failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    const trimmed = reqText.trim();
    if (trimmed.length < 10) { addToast('Requirement text must be at least 10 characters', 'error'); return; }
    if (trimmed.length > 5000) { addToast('Requirement text must be at most 5000 characters', 'error'); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/requirements`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ text: trimmed, useAI, requirementId: artifact.requirement_id }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('Catalog item regenerated from new requirement', 'success');
        onUpdated();
        onClose();
      } else {
        addToast(`Regeneration failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const addVariable = () =>
    setVariables(v => [...v, { name: '', label: '', type: 'string', mandatory: false }]);

  const removeVariable = (i) =>
    setVariables(v => v.filter((_, idx) => idx !== i));

  const updateVariable = (i, field, value) =>
    setVariables(v => v.map((item, idx) => idx === i ? { ...item, [field]: value } : item));

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>✏️ Update Catalog Item</h3>
            <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#888' }}>
              {arts.catalogItem?.name || artifact.name}
            </p>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e0e0e0', background: '#f8f9fa' }}>
          {[
            ['fields', '⚙️ Edit Fields Directly'],
            ['requirement', '🔄 Update via Requirement Text'],
          ].map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: '10px 20px', border: 'none',
              background: mode === m ? '#fff' : 'transparent',
              borderBottom: `2px solid ${mode === m ? '#667eea' : 'transparent'}`,
              cursor: 'pointer', fontSize: '13px',
              fontWeight: mode === m ? '600' : 'normal',
              color: mode === m ? '#667eea' : '#666',
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {mode === 'fields' ? (
            <FieldsEditor
              name={name} setName={setName}
              description={description} setDescription={setDescription}
              variables={variables}
              onAdd={addVariable}
              onRemove={removeVariable}
              onUpdate={updateVariable}
            />
          ) : (
            <RequirementEditor
              reqText={reqText} setReqText={setReqText}
              useAI={useAI} setUseAI={setUseAI}
              originalName={arts.catalogItem?.name || artifact.name}
            />
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button onClick={onClose} disabled={saving} style={cancelBtnStyle}>Cancel</button>
          <button
            onClick={mode === 'fields' ? handleSaveFields : handleRegenerate}
            disabled={saving}
            style={{ ...saveBtnStyle, opacity: saving ? 0.7 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? '⏳ Saving…' : mode === 'fields' ? '💾 Save Changes' : '🔄 Regenerate'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Fields ───────────────────────────────────────────────────────────────

function FieldsEditor({ name, setName, description, setDescription, variables, onAdd, onRemove, onUpdate }) {
  return (
    <div>
      <Field label="Catalog Item Name *">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          style={inputStyle}
          placeholder="e.g. New Employee Onboarding"
        />
      </Field>
      <Field label="Short Description">
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
          placeholder="Brief description of this catalog item…"
        />
      </Field>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={labelStyle}>Variables ({variables.length})</span>
        <button onClick={onAdd} style={addVarBtnStyle}>+ Add Variable</button>
      </div>

      {variables.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#aaa', padding: '24px 0', fontSize: '13px', border: '1px dashed #ddd', borderRadius: '8px' }}>
          No variables defined. Click "+ Add Variable" to add one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {variables.map((v, i) => (
            <VariableRow key={i} v={v} index={i} onUpdate={onUpdate} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

function VariableRow({ v, index, onUpdate, onRemove }) {
  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: '8px', padding: '12px', background: '#fafafa' }}>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <div style={{ flex: 1 }}>
          <label style={{ ...labelStyle, fontSize: '11px' }}>Internal Name</label>
          <input
            value={v.name}
            onChange={e => onUpdate(index, 'name', e.target.value.replace(/\s+/g, '_').toLowerCase())}
            style={{ ...inputStyle, fontSize: '12px' }}
            placeholder="variable_name"
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ ...labelStyle, fontSize: '11px' }}>Display Label</label>
          <input
            value={v.label || ''}
            onChange={e => onUpdate(index, 'label', e.target.value)}
            style={{ ...inputStyle, fontSize: '12px' }}
            placeholder="Variable Label"
          />
        </div>
        <button
          onClick={() => onRemove(index)}
          style={{ alignSelf: 'flex-end', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '5px', padding: '6px 10px', cursor: 'pointer', fontSize: '13px' }}
          title="Remove variable"
        >✕</button>
      </div>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '140px' }}>
          <label style={{ ...labelStyle, fontSize: '11px' }}>Type</label>
          <select
            value={v.type || 'string'}
            onChange={e => onUpdate(index, 'type', e.target.value)}
            style={{ ...inputStyle, fontSize: '12px' }}
          >
            {VAR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#555', marginTop: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={!!v.mandatory}
            onChange={e => onUpdate(index, 'mandatory', e.target.checked)}
          />
          Mandatory
        </label>
      </div>

      {v.type === 'choice' && (
        <div style={{ marginTop: '8px' }}>
          <label style={{ ...labelStyle, fontSize: '11px' }}>Choices (comma-separated)</label>
          <input
            value={Array.isArray(v.choices) ? v.choices.join(', ') : (v.choices || '')}
            onChange={e => onUpdate(index, 'choices', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            style={{ ...inputStyle, fontSize: '12px' }}
            placeholder="Option A, Option B, Option C"
          />
        </div>
      )}

      {v.type === 'reference' && (
        <div style={{ marginTop: '8px' }}>
          <label style={{ ...labelStyle, fontSize: '11px' }}>Reference Table</label>
          <input
            value={v.referenceTable || ''}
            onChange={e => onUpdate(index, 'referenceTable', e.target.value)}
            style={{ ...inputStyle, fontSize: '12px' }}
            placeholder="sys_user"
          />
        </div>
      )}

      {v.sys_id && (
        <div style={{ marginTop: '6px', fontSize: '10px', color: '#aaa' }}>
          sys_id: <code>{v.sys_id}</code>
          {v.status && <span style={{ marginLeft: '8px', color: '#27ae60' }}>({v.status})</span>}
        </div>
      )}
    </div>
  );
}

// ── Requirement re-run ────────────────────────────────────────────────────────

function RequirementEditor({ reqText, setReqText, useAI, setUseAI, originalName }) {
  const remaining = 5000 - reqText.length;
  return (
    <div>
      <div style={{ padding: '12px 14px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '8px', marginBottom: '16px', fontSize: '12px', color: '#856404', lineHeight: 1.5 }}>
        <strong>Updating:</strong> {originalName}<br />
        Enter a new requirement description. The AI will regenerate all artifact definitions
        (variables, flow, scripts) while preserving any previously deployed sys_ids.
      </div>

      <Field label="New Requirement Text *">
        <textarea
          value={reqText}
          onChange={e => setReqText(e.target.value)}
          rows={9}
          maxLength={5000}
          placeholder="Describe the updated catalog item…&#10;&#10;Example: Update the laptop request catalog item to include a field for business justification (mandatory), preferred brand (choice: Dell, HP, Apple), and urgency (High/Medium/Low). Require manager approval for items over $1500."
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ textAlign: 'right', fontSize: '11px', color: remaining < 200 ? '#e74c3c' : '#aaa', marginTop: '2px' }}>
          {remaining} characters remaining
        </div>
      </Field>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: '#555', marginTop: '8px' }}>
        <input type="checkbox" checked={useAI} onChange={e => setUseAI(e.target.checked)} />
        Use AI interpretation <span style={{ color: '#888', fontSize: '11px' }}>(recommended — uses OpenRouter LLM)</span>
      </label>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const modalStyle = {
  background: '#fff', borderRadius: '12px', width: '700px', maxWidth: '96vw',
  maxHeight: '92vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden',
};
const headerStyle = {
  padding: '18px 20px', borderBottom: '1px solid #e0e0e0',
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  background: '#f8f9fa',
};
const footerStyle = {
  padding: '14px 20px', borderTop: '1px solid #e0e0e0',
  display: 'flex', justifyContent: 'flex-end', gap: '10px', background: '#f8f9fa',
};
const closeBtnStyle = {
  background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer',
  color: '#888', padding: '0 4px', lineHeight: 1,
};
const cancelBtnStyle = {
  padding: '8px 18px', border: '1px solid #ddd', borderRadius: '6px',
  background: '#fff', cursor: 'pointer', fontSize: '13px', color: '#555',
};
const saveBtnStyle = {
  padding: '8px 20px', border: 'none', borderRadius: '6px',
  background: '#667eea', color: '#fff', fontSize: '13px', fontWeight: '600',
};
const addVarBtnStyle = {
  padding: '5px 14px', background: '#27ae60', color: '#fff',
  border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
};
const labelStyle = {
  display: 'block', fontSize: '12px', fontWeight: '600', color: '#555', marginBottom: '5px',
};
const inputStyle = {
  width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: '6px',
  fontSize: '13px', boxSizing: 'border-box', outline: 'none', background: '#fff',
};
