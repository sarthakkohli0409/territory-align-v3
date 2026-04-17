/**
 * TerritoryAlign — API Client
 * Automatically detects whether running locally (Docker) or on Render.
 */

// On Render, the frontend static site proxies /api to the backend.
// Locally, nginx also proxies /api to the backend.
// So /api always works regardless of environment.
const API_BASE = 'https://territory-align-api.onrender.com/api';

const Auth = {
  getToken:   ()  => localStorage.getItem('ta_token'),
  getUser:    ()  => JSON.parse(localStorage.getItem('ta_user') || 'null'),
  setToken:   (t) => localStorage.setItem('ta_token', t),
  setUser:    (u) => localStorage.setItem('ta_user', JSON.stringify(u)),
  clear:      ()  => { localStorage.removeItem('ta_token'); localStorage.removeItem('ta_user'); },
  isLoggedIn: ()  => !!localStorage.getItem('ta_token'),
};

async function apiFetch(path, options = {}) {
  const token = Auth.getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  if (options.body instanceof FormData) delete headers['Content-Type'];

  const res = await fetch(API_BASE + path, { ...options, headers });

  if (res.status === 401) {
    Auth.clear();
    window.location.href = '/login.html';
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const api = {
  auth: {
    async login(personnel_id, password) {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ personnel_id, password }),
      });
      Auth.setToken(data.token);
      Auth.setUser(data.user);
      return data.user;
    },
    async me()     { return apiFetch('/auth/me'); },
    async logout() { await apiFetch('/auth/logout', { method: 'POST' }); Auth.clear(); },
  },

  territories: {
    list(p = {})   { return apiFetch('/territories?' + new URLSearchParams(p)); },
    get(id)        { return apiFetch(`/territories/${id}`); },
    getHCPs(id, p) { return apiFetch(`/territories/${id}/hcps?` + new URLSearchParams(p)); },
    getZIPs(id, p) { return apiFetch(`/territories/${id}/zips?` + new URLSearchParams(p)); },
    update(id, b)  { return apiFetch(`/territories/${id}`, { method:'PUT', body:JSON.stringify(b) }); },
  },

  hcps: {
    list(p = {})            { return apiFetch('/hcps?' + new URLSearchParams(p)); },
    get(hcp_id)             { return apiFetch(`/hcps/${hcp_id}`); },
    reassign(hcp_id, terr)  { return apiFetch(`/hcps/${hcp_id}/territory`, { method:'PUT', body:JSON.stringify({new_territory_name:terr}) }); },
  },

  zips: {
    list(p = {})     { return apiFetch('/zips?' + new URLSearchParams(p)); },
    conflicts()      { return apiFetch('/zips/conflicts'); },
    reassign(c, t)   { return apiFetch(`/zips/${c}/territory`, { method:'PUT', body:JSON.stringify({new_territory_name:t}) }); },
  },

  requests: {
    list(p = {})     { return apiFetch('/requests?' + new URLSearchParams(p)); },
    get(id)          { return apiFetch(`/requests/${id}`); },
    create(body)     { return apiFetch('/requests', { method:'POST', body:JSON.stringify(body) }); },
    approve(id)      { return apiFetch(`/requests/${id}/approve`, { method:'PUT' }); },
    reject(id, r)    { return apiFetch(`/requests/${id}/reject`, { method:'PUT', body:JSON.stringify({rejection_reason:r}) }); },
    comment(id, c)   { return apiFetch(`/requests/${id}/comment`, { method:'POST', body:JSON.stringify({comment:c}) }); },
  },

  audit: {
    list(p = {})  { return apiFetch('/audit?' + new URLSearchParams(p)); },
    exportCSV()   { return apiFetch('/export/audit'); },
  },

  versions: {
    list()             { return apiFetch('/versions'); },
    rollback(l, r)     { return apiFetch(`/versions/${l}/rollback`, { method:'POST', body:JSON.stringify({reason:r}) }); },
  },

  roster: {
    list(p = {})  { return apiFetch('/roster?' + new URLSearchParams(p)); },
  },

  conflicts: {
    list()  { return apiFetch('/conflicts'); },
  },

  exports: {
    async downloadCSV(endpoint, filename) {
      const res  = await apiFetch(endpoint);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    },
    ztt()         { return api.exports.downloadCSV('/export/ztt',         `ZTT_${Date.now()}.csv`); },
    audit()       { return api.exports.downloadCSV('/export/audit',       `audit_${Date.now()}.csv`); },
    territories() { return api.exports.downloadCSV('/export/territories', `territories_${Date.now()}.csv`); },
  },

  upload: {
    async file(file, mode = 'append') {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      return apiFetch('/upload', { method: 'POST', body: fd });
    },
  },
};

function requireAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

window.api  = api;
window.Auth = Auth;
window.requireAuth = requireAuth;
