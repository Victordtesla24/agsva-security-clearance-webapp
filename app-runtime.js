const FALLBACK_STATE_KEY = 'agsva-app-state-v3';
  const LEGACY_STATE_KEY = 'agsva-app-state-v2';
  const FIREBASE_VAULT_KEY = 'agsva-firebase-vault-v1';
  const SERVER_STATE_ENDPOINT = '/api/app-state';
  const SERVER_DOCUMENT_ENDPOINT = '/api/documents';
  const VALID_DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);
  const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
  const FIREBASE_CHUNK_SIZE = 240000;
  const REQUIRED_PERSONAL_FIELDS = ['full-name', 'dob', 'citizenship', 'passport-no', 'current-addr', 'phone', 'email'];
  const legacyProcessFiles = typeof processFiles === 'function' ? processFiles : null;
  const legacyPreviewDoc = typeof previewDoc === 'function' ? previewDoc : null;
  const legacyRemoveDoc = typeof removeDoc === 'function' ? removeDoc : null;

let persistenceBackend = 'server';
  let persistenceReady = false;
  let persistenceHydrating = false;
  let autosaveTimer = 0;
  let lastPersistedFingerprint = '';
  let saveQueue = Promise.resolve();
  let firebaseVault = null;
  const firebaseArtifactUrlCache = new Map();
  const persistenceDiagnostics = {
    attempts: 0,
    successes: 0,
    lastError: '',
    lastSavedAt: '',
    lastBackend: 'server'
  };

APP_STATE.meta = APP_STATE.meta || {};
  APP_STATE.formData = APP_STATE.formData || {};
  APP_STATE.meta.refereePdfGeneratedAt = APP_STATE.meta.refereePdfGeneratedAt || '';
  APP_STATE.meta.applicationPdfGeneratedAt = APP_STATE.meta.applicationPdfGeneratedAt || '';
  APP_STATE.meta.lastSavedAt = APP_STATE.meta.lastSavedAt || '';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function getElement(id) {
    return document.getElementById(id);
  }

  function getFieldValue(id) {
    const element = getElement(id);
    if (!element) return '';
    if (element.type === 'checkbox') return element.checked;
    return element.value != null ? String(element.value) : '';
  }

  function hasMeaningfulValue(element) {
    if (!element) return false;
    if (element.type === 'checkbox') return element.checked;
    return String(element.value || '').trim().length > 0;
  }

  function setFieldValidationState(id, message = '') {
    const element = getElement(id);
    if (!element) return;
    const hasError = Boolean(message);
    element.classList.toggle('error', hasError);
    element.classList.toggle('valid', !hasError && hasMeaningfulValue(element));
    if (hasError) {
      element.setAttribute('aria-invalid', 'true');
    } else {
      element.removeAttribute('aria-invalid');
    }
    if (hasError) {
      element.dataset.validationMessage = message;
      element.title = message;
    } else {
      delete element.dataset.validationMessage;
      if (element.title) element.removeAttribute('title');
    }
  }

  function normalizePhone(value) {
    return String(value || '').replace(/[^\d+]/g, '');
  }

  function isValidPhone(value) {
    const normalized = normalizePhone(value);
    const digits = normalized.replace(/\D/g, '');
    return digits.length >= 8;
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function monthValueToDate(monthValue, endOfMonth = false) {
    if (!monthValue) return '';
    const match = /^(\d{4})-(\d{2})$/.exec(monthValue);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (endOfMonth) {
      const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return `${match[1]}-${match[2]}-${String(day).padStart(2, '0')}`;
    }
    return `${match[1]}-${match[2]}-01`;
  }

  function formatMonthDisplay(value) {
    if (!value) return 'Present';
    if (/^\d{4}-\d{2}$/u.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value.slice(0, 7);
    return value;
  }

  function countWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function percentage(part, whole) {
    if (!whole) return 0;
    return Math.round((part / whole) * 100);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function fingerprint(value) {
    return JSON.stringify(value);
  }

  function randomHex(bytes = 16) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function base64FromBytes(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function bytesFromBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function importAesKey(keyBase64) {
    return crypto.subtle.importKey(
      'raw',
      bytesFromBase64(keyBase64),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function getOrCreateFirebaseVault() {
    if (firebaseVault) return firebaseVault;

    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(FIREBASE_VAULT_KEY) || 'null');
    } catch (error) {
      console.warn('Ignoring invalid Firebase vault metadata', error);
    }

    if (!parsed?.vaultId || !parsed?.keyBase64) {
      parsed = {
        version: 1,
        vaultId: randomHex(18),
        keyBase64: base64FromBytes(crypto.getRandomValues(new Uint8Array(32))),
        createdAt: new Date().toISOString()
      };
      localStorage.setItem(FIREBASE_VAULT_KEY, JSON.stringify(parsed));
    }

    firebaseVault = {
      ...parsed,
      key: await importAesKey(parsed.keyBase64)
    };
    return firebaseVault;
  }

  async function encryptText(text) {
    const vault = await getOrCreateFirebaseVault();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(String(text ?? ''));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.key, encoded);
    return {
      iv: base64FromBytes(iv),
      ciphertext: base64FromBytes(new Uint8Array(encrypted))
    };
  }

  async function decryptText(ciphertext, iv) {
    const vault = await getOrCreateFirebaseVault();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesFromBase64(iv) },
      vault.key,
      bytesFromBase64(ciphertext)
    );
    return new TextDecoder().decode(decrypted);
  }

  function chunkString(value, chunkSize = FIREBASE_CHUNK_SIZE) {
    const chunks = [];
    for (let index = 0; index < value.length; index += chunkSize) {
      chunks.push(value.slice(index, index + chunkSize));
    }
    return chunks.length ? chunks : [''];
  }

  function firebaseConfig() {
    return window.__AGSVA_FIREBASE_CONFIG__ && typeof window.__AGSVA_FIREBASE_CONFIG__ === 'object'
      ? window.__AGSVA_FIREBASE_CONFIG__
      : null;
  }

  function firebaseProjectId() {
    return firebaseConfig()?.projectId || '';
  }

  function firebaseApiKey() {
    return firebaseConfig()?.apiKey || '';
  }

  function firebaseDocumentUrl(...segments) {
    const encodedSegments = segments.map((segment) => encodeURIComponent(segment)).join('/');
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId())}/databases/(default)/documents/${encodedSegments}?key=${encodeURIComponent(firebaseApiKey())}`;
  }

  function firestoreStringField(value) {
    return { stringValue: String(value ?? '') };
  }

  function firestoreIntegerField(value) {
    return { integerValue: String(Math.trunc(Number(value) || 0)) };
  }

  function decodeFirestoreField(field) {
    if (!field || typeof field !== 'object') return null;
    if ('stringValue' in field) return field.stringValue;
    if ('integerValue' in field) return Number.parseInt(field.integerValue, 10);
    return null;
  }

  async function firestoreRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    if (response.status === 404) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Firestore request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  function preferredPersistenceMode() {
    const override = new URLSearchParams(window.location.search).get('storage');
    if (override === 'browser' || override === 'server' || override === 'firebase') return override;

    if (firebaseConfig() && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/u.test(window.location.hostname)) {
      return 'firebase';
    }

    return 'server';
  }

  async function initializeFirebasePersistence() {
    const config = firebaseConfig();
    if (!config?.projectId || !config?.apiKey) {
      throw new Error('Firebase configuration is incomplete.');
    }
    return getOrCreateFirebaseVault();
  }

  function createBlobUrlFromBase64(base64, mimeType) {
    const blob = new Blob([bytesFromBase64(base64)], { type: mimeType || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }

  async function loadFirebaseSnapshot() {
    await initializeFirebasePersistence();
    const payload = await firestoreRequest(firebaseDocumentUrl('vaults', firebaseVault.vaultId), { method: 'GET' });
    if (!payload?.fields) return null;

    const ciphertext = decodeFirestoreField(payload.fields.ciphertext);
    const iv = decodeFirestoreField(payload.fields.iv);
    if (!ciphertext || !iv) return null;

    const decrypted = await decryptText(ciphertext, iv);
    return JSON.parse(decrypted);
  }

  async function hydrateFromFirebase() {
    persistenceBackend = 'firebase';
    const state = await loadFirebaseSnapshot();
    persistenceHydrating = true;
    try {
      applyLoadedState(state || {}, []);
      persistenceReady = true;
    } finally {
      persistenceHydrating = false;
    }
  }

  async function persistFirebaseSnapshot(snapshot) {
    await initializeFirebasePersistence();
    const encrypted = await encryptText(JSON.stringify(snapshot));
    await firestoreRequest(firebaseDocumentUrl('vaults', firebaseVault.vaultId), {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          ciphertext: firestoreStringField(encrypted.ciphertext),
          iv: firestoreStringField(encrypted.iv),
          schemaVersion: firestoreIntegerField(1),
          updatedAt: firestoreIntegerField(Date.now())
        }
      })
    });
  }

  async function storeFirebaseDocument(file, category, validationState, contentBase64) {
    await initializeFirebasePersistence();

    const encrypted = await encryptText(contentBase64);
    const chunks = chunkString(encrypted.ciphertext);
    const documentId = randomHex(16);
    await Promise.all(chunks.map((chunk, index) => {
      return firestoreRequest(
        firebaseDocumentUrl('vaults', firebaseVault.vaultId, 'artifacts', documentId, 'chunks', String(index).padStart(5, '0')),
        {
          method: 'PATCH',
          body: JSON.stringify({
            fields: {
              value: firestoreStringField(chunk)
            }
          })
        }
      );
    }));
    return {
      id: documentId,
      category,
      name: file.name,
      type: file.type,
      size: file.size,
      validationState,
      storage: {
        provider: 'firebase-firestore',
        chunkCount: chunks.length,
        iv: encrypted.iv
      }
    };
  }

  async function loadFirebaseDocumentBase64(documentRecord) {
    await initializeFirebasePersistence();

    const storage = documentRecord?.storage || {};
    const chunkCount = Number(storage.chunkCount || 0);
    if (!documentRecord?.id || !storage.iv || chunkCount <= 0) {
      throw new Error('Document metadata is incomplete.');
    }

    const chunks = await Promise.all(Array.from({ length: chunkCount }, (_, index) => {
      return firestoreRequest(
        firebaseDocumentUrl('vaults', firebaseVault.vaultId, 'artifacts', documentRecord.id, 'chunks', String(index).padStart(5, '0')),
        { method: 'GET' }
      );
    }));
    const ciphertext = chunks.map((snapshot) => decodeFirestoreField(snapshot?.fields?.value) || '').join('');
    return decryptText(ciphertext, storage.iv);
  }

  async function openFirebaseDocument(documentRecord) {
    const cachedUrl = firebaseArtifactUrlCache.get(documentRecord.id);
    if (cachedUrl) {
      window.open(cachedUrl, '_blank', 'noopener');
      return;
    }

    const contentBase64 = await loadFirebaseDocumentBase64(documentRecord);
    const blobUrl = createBlobUrlFromBase64(contentBase64, documentRecord.type);
    firebaseArtifactUrlCache.set(documentRecord.id, blobUrl);
    window.open(blobUrl, '_blank', 'noopener');
  }

  async function deleteFirebaseDocument(documentRecord) {
    await initializeFirebasePersistence();

    const storage = documentRecord?.storage || {};
    const chunkCount = Number(storage.chunkCount || 0);
    if (!documentRecord?.id || chunkCount <= 0) return;

    await Promise.all(Array.from({ length: chunkCount }, (_, index) => {
      return firestoreRequest(
        firebaseDocumentUrl('vaults', firebaseVault.vaultId, 'artifacts', documentRecord.id, 'chunks', String(index).padStart(5, '0')),
        { method: 'DELETE' }
      );
    }));

    const cachedUrl = firebaseArtifactUrlCache.get(documentRecord.id);
    if (cachedUrl) {
      URL.revokeObjectURL(cachedUrl);
      firebaseArtifactUrlCache.delete(documentRecord.id);
    }
  }

  function extractIndices(selector, pattern) {
    const indices = new Set();
    document.querySelectorAll(`${selector} [id]`).forEach((element) => {
      const match = element.id.match(pattern);
      if (match) indices.add(Number(match[1]));
    });
    return Array.from(indices).sort((left, right) => left - right);
  }

  function captureFormData() {
    const formData = {};
    document.querySelectorAll('input[id], select[id], textarea[id]').forEach((element) => {
      if (element.type === 'file') return;
      formData[element.id] = element.type === 'checkbox' ? element.checked : element.value;
    });
    return formData;
  }

  function seedFormDataFromState(state) {
    const formData = { ...(state.formData || {}) };

    if (!formData['full-name'] && state.personal?.fullName) formData['full-name'] = state.personal.fullName;
    if (!formData['dob'] && state.personal?.dob) formData['dob'] = state.personal.dob;
    if (!formData['citizenship'] && state.personal?.citizenship) formData['citizenship'] = String(state.personal.citizenship).toLowerCase();
    if (!formData['passport-no'] && state.personal?.passportNumber) formData['passport-no'] = state.personal.passportNumber;
    if (!formData['current-addr'] && state.personal?.currentAddress) formData['current-addr'] = state.personal.currentAddress;
    if (!formData['phone'] && state.personal?.phone) formData['phone'] = state.personal.phone;
    if (!formData['email'] && state.personal?.email) formData['email'] = state.personal.email;
    if (!formData['tax-file'] && state.personal?.tfn) formData['tax-file'] = state.personal.tfn;

    if (Array.isArray(state.employment)) {
      state.employment.forEach((entry, index) => {
        const slot = index + 1;
        if (entry.employer) formData[`emp${slot}-employer`] = entry.employer;
        if (entry.role) formData[`emp${slot}-position`] = entry.role;
        if (entry.from) formData[`emp${slot}-start`] = String(entry.from).slice(0, 7);
        if (entry.to) formData[`emp${slot}-end`] = String(entry.to).slice(0, 7);
        if (entry.address) formData[`emp${slot}-addr`] = entry.address;
        if (entry.supervisorName) formData[`emp${slot}-supervisor`] = entry.supervisorName;
        if (entry.supervisorPhone) formData[`emp${slot}-sup-phone`] = entry.supervisorPhone;
      });
    }

    if (Array.isArray(state.addresses)) {
      state.addresses.forEach((entry, index) => {
        const slot = index + 1;
        if (entry.street) formData[`addr${slot}-street`] = entry.street;
        if (entry.suburb) formData[`addr${slot}-suburb`] = entry.suburb;
        if (entry.state) formData[`addr${slot}-state`] = entry.state;
        if (entry.from) formData[`addr${slot}-from`] = String(entry.from).slice(0, 7);
        if (entry.to) formData[`addr${slot}-to`] = String(entry.to).slice(0, 7);
      });
    }

    if (state.familyDetails) {
      const family = state.familyDetails;
      if (family.partnerStatus) formData['partner-status'] = family.partnerStatus;
      if (family.partnerName) formData['partner-name'] = family.partnerName;
      if (family.partnerDob) formData['partner-dob'] = family.partnerDob;
      if (family.partnerCitizenship) formData['partner-citizenship'] = family.partnerCitizenship;
      if (family.partnerEmployer) formData['partner-employer'] = family.partnerEmployer;
      if (family.fatherName) formData['father-name'] = family.fatherName;
      if (family.fatherCitizenship) formData['father-citizenship'] = family.fatherCitizenship;
      if (family.motherName) formData['mother-name'] = family.motherName;
      if (family.motherCitizenship) formData['mother-citizenship'] = family.motherCitizenship;

      if (Array.isArray(family.children)) {
        family.children.forEach((child, index) => {
          const slot = index + 1;
          if (child.name) formData[`child${slot}-name`] = child.name;
          if (child.dob) formData[`child${slot}-dob`] = child.dob;
          if (child.citizenship) formData[`child${slot}-citizenship`] = child.citizenship;
        });
      }
    }

    if (state.financialProfile) {
      const financial = state.financialProfile;
      if (financial.income != null) formData['fin-income'] = financial.income;
      if (financial.bank) formData['fin-employer-bank'] = financial.bank;
      if (financial.bankruptcy) formData['fin-bankruptcy'] = financial.bankruptcy;
      if (financial.debts) formData['fin-debts'] = financial.debts;
      if (financial.foreignAssets) formData['fin-foreign-assets'] = financial.foreignAssets;
      if (financial.notes) formData['fin-notes'] = financial.notes;
    }

    if (!formData['disclosure-editor'] && state.disclosureDraft?.statement) {
      formData['disclosure-editor'] = state.disclosureDraft.statement;
    }

    return formData;
  }

  function ensureDynamicEntries(formData) {
    const findMax = (pattern) => {
      return Object.keys(formData).reduce((max, key) => {
        const match = key.match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
    };

    const maxEmployment = findMax(/^emp(\d+)-/);
    const maxAddresses = findMax(/^addr(\d+)-/);
    const maxChildren = findMax(/^child(\d+)-/);

    while (extractIndices('#employment-entries', /^emp(\d+)-/).length < maxEmployment) {
      addEmploymentEntry(false);
    }

    while (extractIndices('#address-entries', /^addr(\d+)-/).length < maxAddresses) {
      addAddressEntry(false);
    }

    while (extractIndices('#children-entries', /^child(\d+)-/).length < maxChildren) {
      addChildEntry(false);
    }
  }

  function applyFormData(formData) {
    Object.entries(formData).forEach(([id, value]) => {
      const element = getElement(id);
      if (!element) return;
      if (element.type === 'checkbox') {
        element.checked = Boolean(value);
      } else {
        element.value = value ?? '';
      }
    });
  }

  function collectPersonalData() {
    return {
      fullName: getFieldValue('full-name').trim(),
      dob: getFieldValue('dob'),
      citizenship: getFieldValue('citizenship'),
      passportNumber: getFieldValue('passport-no').trim(),
      currentAddress: getFieldValue('current-addr').trim(),
      phone: getFieldValue('phone').trim(),
      email: getFieldValue('email').trim(),
      tfn: getFieldValue('tax-file').trim()
    };
  }

  function collectEmploymentEntries() {
    return extractIndices('#employment-entries', /^emp(\d+)-/).map((slot) => ({
      slot,
      id: `emp-${slot}`,
      employer: getFieldValue(`emp${slot}-employer`).trim(),
      role: getFieldValue(`emp${slot}-position`).trim(),
      from: monthValueToDate(getFieldValue(`emp${slot}-start`)),
      to: monthValueToDate(getFieldValue(`emp${slot}-end`), true),
      address: getFieldValue(`emp${slot}-addr`).trim(),
      supervisorName: getFieldValue(`emp${slot}-supervisor`).trim(),
      supervisorPhone: getFieldValue(`emp${slot}-sup-phone`).trim()
    })).filter((entry) => Object.values(entry).some((value) => String(value || '').trim().length > 0));
  }

  function collectAddressEntries() {
    return extractIndices('#address-entries', /^addr(\d+)-/).map((slot) => ({
      slot,
      id: `addr-${slot}`,
      street: getFieldValue(`addr${slot}-street`).trim(),
      suburb: getFieldValue(`addr${slot}-suburb`).trim(),
      state: getFieldValue(`addr${slot}-state`).trim(),
      from: monthValueToDate(getFieldValue(`addr${slot}-from`)),
      to: monthValueToDate(getFieldValue(`addr${slot}-to`), true)
    })).filter((entry) => Object.values(entry).some((value) => String(value || '').trim().length > 0));
  }

  function collectChildren() {
    return extractIndices('#children-entries', /^child(\d+)-/).map((slot) => ({
      slot,
      id: `child-${slot}`,
      name: getFieldValue(`child${slot}-name`).trim(),
      dob: getFieldValue(`child${slot}-dob`),
      citizenship: getFieldValue(`child${slot}-citizenship`).trim()
    })).filter((entry) => entry.name || entry.dob || entry.citizenship);
  }

  function collectFamilyDetails() {
    return {
      partnerStatus: getFieldValue('partner-status'),
      partnerName: getFieldValue('partner-name').trim(),
      partnerDob: getFieldValue('partner-dob'),
      partnerCitizenship: getFieldValue('partner-citizenship').trim(),
      partnerEmployer: getFieldValue('partner-employer').trim(),
      fatherName: getFieldValue('father-name').trim(),
      fatherCitizenship: getFieldValue('father-citizenship').trim(),
      motherName: getFieldValue('mother-name').trim(),
      motherCitizenship: getFieldValue('mother-citizenship').trim(),
      children: collectChildren()
    };
  }

  function collectFinancialProfile() {
    return {
      income: Number.parseInt(getFieldValue('fin-income'), 10) || 0,
      bank: getFieldValue('fin-employer-bank').trim(),
      bankruptcy: getFieldValue('fin-bankruptcy'),
      debts: getFieldValue('fin-debts'),
      foreignAssets: getFieldValue('fin-foreign-assets').trim(),
      notes: getFieldValue('fin-notes').trim()
    };
  }

  function collectDisclosureDraft() {
    const statement = getFieldValue('disclosure-editor');
    return {
      statement,
      wordCount: countWords(statement)
    };
  }

  function updateFinancialSummary() {
    const liabilities = getElement('fin-liabilities');
    if (!liabilities) return;
    const financial = APP_STATE.financialProfile || {};
    liabilities.textContent = financial.debts === 'yes' ? 'Declared' : '$0';
  }

  function validatePersonalSection(options = {}) {
    const markFields = Boolean(options.markFields);
    const personal = collectPersonalData();
    const fieldErrors = {};

    if (!personal.fullName || personal.fullName.length < 3) fieldErrors['full-name'] = 'Enter the applicant’s full legal name.';
    if (!personal.dob) fieldErrors.dob = 'Enter the applicant’s date of birth.';
    if (personal.dob) {
      const age = (Date.now() - new Date(personal.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (!Number.isFinite(age) || age < 18) fieldErrors.dob = 'Applicant must be at least 18 years old.';
    }
    if (!personal.citizenship) fieldErrors.citizenship = 'Select the applicant’s citizenship status.';
    if (!personal.passportNumber || !/^[A-Z0-9]{6,12}$/i.test(personal.passportNumber)) fieldErrors['passport-no'] = 'Enter a valid passport number.';
    if (!personal.currentAddress || personal.currentAddress.length < 10) fieldErrors['current-addr'] = 'Enter the applicant’s full current address.';
    if (!personal.phone || !isValidPhone(personal.phone)) fieldErrors.phone = 'Enter a valid contact phone number.';
    if (!personal.email || !isValidEmail(personal.email)) fieldErrors.email = 'Enter a valid email address.';

    if (markFields) {
      REQUIRED_PERSONAL_FIELDS.forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
    }

    const validCount = REQUIRED_PERSONAL_FIELDS.filter((id) => !fieldErrors[id] && String(getFieldValue(id)).trim()).length;
    return {
      valid: Object.keys(fieldErrors).length === 0,
      issues: Object.values(fieldErrors),
      progress: percentage(validCount, REQUIRED_PERSONAL_FIELDS.length)
    };
  }

  function validateEmploymentSection(options = {}) {
    const markFields = Boolean(options.markFields);
    const entries = collectEmploymentEntries();
    const fieldErrors = {};
    const requiredFields = [];
    let validRequiredFields = 0;

    entries.forEach((entry) => {
      const slot = entry.slot;
      const checks = {
        [`emp${slot}-employer`]: entry.employer ? '' : 'Enter the employer name.',
        [`emp${slot}-position`]: entry.role ? '' : 'Enter the position title.',
        [`emp${slot}-start`]: entry.from ? '' : 'Enter the employment start date.',
        [`emp${slot}-addr`]: entry.address ? '' : 'Enter the employer address.',
        [`emp${slot}-supervisor`]: entry.supervisorName ? '' : 'Enter the supervisor name.',
        [`emp${slot}-sup-phone`]: entry.supervisorPhone && isValidPhone(entry.supervisorPhone) ? '' : 'Enter a valid supervisor phone number.'
      };

      Object.entries(checks).forEach(([id, message]) => {
        requiredFields.push(id);
        if (!message) validRequiredFields += 1;
        if (message) fieldErrors[id] = message;
      });

      const endFieldId = `emp${slot}-end`;
      if (entry.from && entry.to && new Date(entry.to) < new Date(entry.from)) {
        fieldErrors[endFieldId] = 'Employment end date must be after the start date.';
      }
      if (markFields) {
        Object.keys(checks).concat(endFieldId).forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
      }
    });

    if (entries.length === 0) {
      return {
        valid: false,
        issues: ['At least one employment history entry is required.'],
        warnings: [],
        progress: 0
      };
    }

    const coverageInput = entries.map((entry) => ({
      employer: entry.employer || 'Employment entry',
      from: entry.from,
      to: entry.to
    }));
    const coverage = validateHistoryCoverage(coverageInput);
    const issues = Object.values(fieldErrors);
    if (!coverage.valid) issues.push(...coverage.gaps.map((gap) => `Employment history gap: ${gap}`));

    return {
      valid: issues.length === 0,
      issues,
      warnings: coverage.warnings,
      progress: Math.min(100, Math.round(((percentage(validRequiredFields, requiredFields.length || 1)) + coverage.coveragePct) / 2))
    };
  }

  function validateAddressSection(options = {}) {
    const markFields = Boolean(options.markFields);
    const entries = collectAddressEntries();
    const fieldErrors = {};
    const requiredFields = [];
    let validRequiredFields = 0;

    entries.forEach((entry) => {
      const slot = entry.slot;
      const checks = {
        [`addr${slot}-street`]: entry.street ? '' : 'Enter the street address.',
        [`addr${slot}-suburb`]: entry.suburb ? '' : 'Enter the suburb.',
        [`addr${slot}-state`]: entry.state ? '' : 'Select the state or territory.',
        [`addr${slot}-from`]: entry.from ? '' : 'Enter the move-in date.'
      };
      Object.entries(checks).forEach(([id, message]) => {
        requiredFields.push(id);
        if (!message) validRequiredFields += 1;
        if (message) fieldErrors[id] = message;
      });
      const endFieldId = `addr${slot}-to`;
      if (entry.from && entry.to && new Date(entry.to) < new Date(entry.from)) {
        fieldErrors[endFieldId] = 'Move-out date must be after the move-in date.';
      }
      if (markFields) {
        Object.keys(checks).concat(endFieldId).forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
      }
    });

    if (entries.length === 0) {
      return {
        valid: false,
        issues: ['At least one address history entry is required.'],
        warnings: [],
        progress: 0
      };
    }

    const coverageInput = entries.map((entry) => ({
      employer: `${entry.street || 'Address'} ${entry.suburb || ''}`.trim(),
      from: entry.from,
      to: entry.to
    }));
    const coverage = validateHistoryCoverage(coverageInput);
    const issues = Object.values(fieldErrors);
    if (!coverage.valid) issues.push(...coverage.gaps.map((gap) => `Address history gap: ${gap}`));

    return {
      valid: issues.length === 0,
      issues,
      warnings: coverage.warnings,
      progress: Math.min(100, Math.round(((percentage(validRequiredFields, requiredFields.length || 1)) + coverage.coveragePct) / 2))
    };
  }

  function validateFamilySection(options = {}) {
    const markFields = Boolean(options.markFields);
    const family = collectFamilyDetails();
    const fieldErrors = {};

    if (!family.partnerStatus) fieldErrors['partner-status'] = 'Select the applicant’s relationship status.';
    if (family.partnerStatus && family.partnerStatus !== 'single') {
      if (!family.partnerName) fieldErrors['partner-name'] = 'Enter the partner or spouse full name.';
      if (!family.partnerDob) fieldErrors['partner-dob'] = 'Enter the partner or spouse date of birth.';
    }
    if (!family.fatherName) fieldErrors['father-name'] = 'Enter the father’s full name.';
    if (!family.motherName) fieldErrors['mother-name'] = 'Enter the mother’s full name.';

    family.children.forEach((child) => {
      const slot = child.slot;
      if (!child.name) fieldErrors[`child${slot}-name`] = 'Enter the child’s full name.';
      if (!child.dob) fieldErrors[`child${slot}-dob`] = 'Enter the child’s date of birth.';
    });

    if (markFields) {
      ['partner-status', 'partner-name', 'partner-dob', 'father-name', 'mother-name']
        .concat(family.children.flatMap((_, index) => [`child${index + 1}-name`, `child${index + 1}-dob`]))
        .forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
    }

    const requiredTotal = 3 + (family.partnerStatus && family.partnerStatus !== 'single' ? 2 : 0) + (family.children.length * 2);
    const validTotal = requiredTotal - Object.keys(fieldErrors).length;

    return {
      valid: Object.keys(fieldErrors).length === 0,
      issues: Object.values(fieldErrors),
      progress: requiredTotal ? percentage(Math.max(validTotal, 0), requiredTotal) : 0
    };
  }

  function validateFinancialSection(options = {}) {
    const markFields = Boolean(options.markFields);
    const financial = collectFinancialProfile();
    const fieldErrors = {};

    if (!financial.income || financial.income <= 0) fieldErrors['fin-income'] = 'Enter the annual gross income in AUD.';
    if (!financial.bankruptcy) fieldErrors['fin-bankruptcy'] = 'Select the bankruptcy or insolvency status.';
    if (!financial.debts) fieldErrors['fin-debts'] = 'Select the outstanding debt status.';
    if ((financial.bankruptcy === 'yes' || financial.debts === 'yes') && financial.notes.length < 20) {
      fieldErrors['fin-notes'] = 'Provide a short explanation for the declared financial issue.';
    }

    if (markFields) {
      ['fin-income', 'fin-bankruptcy', 'fin-debts', 'fin-notes'].forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
    }

    const requiredFields = ['fin-income', 'fin-bankruptcy', 'fin-debts'];
    const validRequired = requiredFields.filter((id) => !fieldErrors[id] && String(getFieldValue(id)).trim()).length;
    const hasNotes = !fieldErrors['fin-notes'];
    const denominator = requiredFields.length + ((financial.bankruptcy === 'yes' || financial.debts === 'yes') ? 1 : 0);
    const numerator = validRequired + (((financial.bankruptcy === 'yes' || financial.debts === 'yes') && hasNotes) ? 1 : 0);

    return {
      valid: Object.keys(fieldErrors).length === 0,
      issues: Object.values(fieldErrors),
      progress: denominator ? percentage(numerator, denominator) : 0
    };
  }

  function validateDisclosureSection(options = {}) {
    const markFields = Boolean(options.markFields);
    const text = getFieldValue('disclosure-editor').trim();
    const lowerText = text.toLowerCase();
    const requiredTerms = ['road safety act', 'vicroads', 'leap', 'no conviction'];
    APP_STATE.legalMatters.forEach((matter) => {
      if (matter.offenceDate) {
        const label = new Date(matter.offenceDate).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }).toLowerCase();
        requiredTerms.push(label);
      }
    });

    const issues = [];
    if (text.length < 300) issues.push('Disclosure statement is too short to explain the legal matters fully.');
    requiredTerms.forEach((term) => {
      if (!lowerText.includes(term)) issues.push(`Disclosure statement is missing required context: ${term}.`);
    });

    if (markFields) setFieldValidationState('disclosure-editor', issues[0] || '');

    const progress = Math.min(100, Math.round((Math.min(text.length, 900) / 900) * 100));
    return {
      valid: issues.length === 0,
      issues,
      progress
    };
  }

  function collectRefereeCandidate() {
    return {
      id: crypto.randomUUID(),
      name: getFieldValue('ref-name').trim(),
      citizenship: getFieldValue('ref-citizenship'),
      role: getFieldValue('ref-role').trim(),
      employer: getFieldValue('ref-employer').trim(),
      from: monthValueToDate(getFieldValue('ref-from')),
      to: monthValueToDate(getFieldValue('ref-to'), true),
      phone: getFieldValue('ref-phone').trim(),
      email: getFieldValue('ref-email').trim(),
      address: getFieldValue('ref-addr').trim(),
      isSupervisor: Boolean(getElement('ref-is-supervisor')?.checked),
      isRelative: Boolean(getElement('ref-is-relative')?.checked),
      isPartner: false
    };
  }

  function validateRefereeCandidate(candidate, options = {}) {
    const markFields = Boolean(options.markFields);
    const fieldErrors = {};

    if (!candidate.name) fieldErrors['ref-name'] = 'Enter the referee full name.';
    if (!candidate.citizenship) fieldErrors['ref-citizenship'] = 'Select the referee citizenship.';
    if (!candidate.role) fieldErrors['ref-role'] = 'Enter the referee role.';
    if (!candidate.employer) fieldErrors['ref-employer'] = 'Enter the referee organisation.';
    if (!candidate.from) fieldErrors['ref-from'] = 'Enter the supervision start date.';
    if (!candidate.phone && !candidate.email) {
      fieldErrors['ref-phone'] = 'Provide at least one referee contact method.';
      fieldErrors['ref-email'] = 'Provide at least one referee contact method.';
    }
    if (candidate.email && !isValidEmail(candidate.email)) fieldErrors['ref-email'] = 'Enter a valid referee email address.';
    if (candidate.phone && !isValidPhone(candidate.phone)) fieldErrors['ref-phone'] = 'Enter a valid referee phone number.';
    if (!candidate.address) fieldErrors['ref-addr'] = 'Enter the referee address.';
    if (candidate.from && candidate.to && new Date(candidate.to) < new Date(candidate.from)) fieldErrors['ref-to'] = 'Referee supervision end date must be after the start date.';

    const agsva = validateRefereeAGSVA(candidate);
    const issues = Object.values(fieldErrors).concat(agsva.errors);
    const warnings = agsva.warnings || [];

    if (markFields) {
      ['ref-name', 'ref-citizenship', 'ref-role', 'ref-employer', 'ref-from', 'ref-to', 'ref-phone', 'ref-email', 'ref-addr']
        .forEach((id) => setFieldValidationState(id, fieldErrors[id] || ''));
    }

    return {
      valid: issues.length === 0,
      issues,
      warnings
    };
  }

  function syncStateFromDom() {
    APP_STATE.personal = collectPersonalData();
    APP_STATE.employment = collectEmploymentEntries();
    APP_STATE.addresses = collectAddressEntries();
    APP_STATE.familyDetails = collectFamilyDetails();
    APP_STATE.financialProfile = collectFinancialProfile();
    APP_STATE.disclosureDraft = collectDisclosureDraft();
    APP_STATE.formData = captureFormData();

    const personalValidation = validatePersonalSection();
    const employmentValidation = validateEmploymentSection();
    const addressValidation = validateAddressSection();
    const familyValidation = validateFamilySection();
    const financialValidation = validateFinancialSection();
    const disclosureValidation = validateDisclosureSection();

    APP_STATE.progress.personal = personalValidation.progress;
    APP_STATE.progress.employment = employmentValidation.progress;
    APP_STATE.progress.address = addressValidation.progress;
    APP_STATE.progress.family = familyValidation.progress;
    APP_STATE.progress.financial = financialValidation.progress;
    APP_STATE.progress.disclosure = disclosureValidation.progress;
    APP_STATE.progress.documents = Math.min(100, percentage(APP_STATE.documents.length, REQUIRED_DOCS.filter((doc) => doc.mandatory).length));
    APP_STATE.progress.referees = APP_STATE.referees.length === 0
      ? 0
      : Math.min(100, 40 + (APP_STATE.referees.filter((ref) => ref.eligible).length * 60));

    updateFinancialSummary();
    return APP_STATE;
  }

  function buildPersistableState() {
    syncStateFromDom();
    return {
      progress: cloneJson(APP_STATE.progress),
      personal: cloneJson(APP_STATE.personal),
      employment: cloneJson(APP_STATE.employment),
      addresses: cloneJson(APP_STATE.addresses),
      documents: cloneJson(APP_STATE.documents),
      referees: cloneJson(APP_STATE.referees),
      legalMatters: cloneJson(APP_STATE.legalMatters),
      exculpatoryEvidence: cloneJson(APP_STATE.exculpatoryEvidence),
      familyDetails: cloneJson(APP_STATE.familyDetails || {}),
      financialProfile: cloneJson(APP_STATE.financialProfile || {}),
      disclosureDraft: cloneJson(APP_STATE.disclosureDraft || {}),
      meta: cloneJson(APP_STATE.meta || {}),
      formData: cloneJson(APP_STATE.formData || {})
    };
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const message = payload?.error || `Request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  function applyLoadedState(state, documents = []) {
    const mergedState = state && typeof state === 'object' ? state : {};
    APP_STATE.progress = { ...APP_STATE.progress, ...(mergedState.progress || {}) };
    APP_STATE.personal = { ...APP_STATE.personal, ...(mergedState.personal || {}) };
    APP_STATE.referees = Array.isArray(mergedState.referees) ? mergedState.referees : APP_STATE.referees;
    APP_STATE.legalMatters = Array.isArray(mergedState.legalMatters) ? mergedState.legalMatters : APP_STATE.legalMatters;
    APP_STATE.exculpatoryEvidence = Array.isArray(mergedState.exculpatoryEvidence) ? mergedState.exculpatoryEvidence : APP_STATE.exculpatoryEvidence;
    APP_STATE.familyDetails = { ...(APP_STATE.familyDetails || {}), ...(mergedState.familyDetails || {}) };
    APP_STATE.financialProfile = { ...(APP_STATE.financialProfile || {}), ...(mergedState.financialProfile || {}) };
    APP_STATE.disclosureDraft = { ...(APP_STATE.disclosureDraft || {}), ...(mergedState.disclosureDraft || {}) };
    APP_STATE.meta = { ...(APP_STATE.meta || {}), ...(mergedState.meta || {}) };
    APP_STATE.formData = seedFormDataFromState(mergedState);
    APP_STATE.documents = Array.isArray(documents) && documents.length
      ? documents
      : Array.isArray(mergedState.documents) ? mergedState.documents : APP_STATE.documents;

    ensureDynamicEntries(APP_STATE.formData);
    applyFormData(APP_STATE.formData);
    renderRefereeCards();
    renderDocChecklist();
    renderUploadedDocs();
    updateDocumentProgress();
    updateWordCount();
    syncStateFromDom();
    updateAllProgress();
    updateStorageMeter();
    lastPersistedFingerprint = fingerprint(buildPersistableState());
  }

  async function hydrateFromServer() {
    const payload = await apiJson(SERVER_STATE_ENDPOINT, { method: 'GET', cache: 'no-store' });
    persistenceHydrating = true;
    try {
      applyLoadedState(payload.state || {}, payload.documents || []);
      persistenceBackend = 'server';
      persistenceReady = true;
    } finally {
      persistenceHydrating = false;
    }
  }

  function restoreState() {
    persistenceHydrating = true;
    try {
      const saved = localStorage.getItem(FALLBACK_STATE_KEY) || sessionStorage.getItem(LEGACY_STATE_KEY);
      if (saved) {
        applyLoadedState(JSON.parse(saved), []);
      } else {
        renderRefereeCards();
        renderDocChecklist();
        renderUploadedDocs();
        syncStateFromDom();
        updateAllProgress();
      }
      if (typeof restoreDocuments === 'function') {
        restoreDocuments().then(() => {
          renderDocChecklist();
          renderUploadedDocs();
          updateDocumentProgress();
          syncStateFromDom();
          updateAllProgress();
        });
      }
    } catch (error) {
      console.warn('Failed to restore browser-backed state', error);
    } finally {
      persistenceHydrating = false;
      persistenceReady = true;
      updateStorageMeter();
    }
  }

  async function persistSnapshot(snapshot) {
    const lastSavedAt = new Date().toISOString();
    snapshot.meta = { ...(snapshot.meta || {}), lastSavedAt };
    const snapshotFingerprint = fingerprint(snapshot);
    if (snapshotFingerprint === lastPersistedFingerprint) return;

    persistenceDiagnostics.attempts += 1;
    persistenceDiagnostics.lastBackend = persistenceBackend;
    persistenceDiagnostics.lastError = '';

    if (persistenceBackend === 'server') {
      await apiJson(SERVER_STATE_ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify({ state: snapshot })
      });
    } else if (persistenceBackend === 'firebase') {
      await persistFirebaseSnapshot(snapshot);
    } else {
      localStorage.setItem(FALLBACK_STATE_KEY, JSON.stringify(snapshot));
    }

    APP_STATE.meta.lastSavedAt = lastSavedAt;
    persistenceDiagnostics.successes += 1;
    persistenceDiagnostics.lastSavedAt = lastSavedAt;
    lastPersistedFingerprint = snapshotFingerprint;
  }

  function queuePersist(immediate = false) {
    if (persistenceHydrating || (immediate && !persistenceReady)) {
      clearTimeout(autosaveTimer);
      autosaveTimer = window.setTimeout(() => queuePersist(immediate), 250);
      return;
    }

    if (!persistenceReady) return;

    const snapshot = buildPersistableState();
    const executeSave = () => {
      saveQueue = saveQueue
        .then(() => persistSnapshot(snapshot))
        .catch((error) => {
          persistenceDiagnostics.lastError = error?.message || String(error);
          console.error('Failed to persist application state', error);
          showToast('⚠️ Unable to save changes right now. Please retry in a moment.', 'info');
        });
    };

    if (immediate) {
      clearTimeout(autosaveTimer);
      executeSave();
      return;
    }

    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(executeSave, 450);
  }

  function autoSave() {
    queuePersist(false);
  }

  async function updateStorageMeter() {
    const bar = getElement('storage-usage-bar');
    const text = getElement('storage-usage-text');
    if (!bar || !text) return;

    if (persistenceBackend === 'server') {
      try {
        const health = await fetch('/api/health', { cache: 'no-store' }).then((response) => response.json());
        const documentsCount = health?.persistence?.documentsCount || 0;
        const documentBytes = health?.persistence?.documentBytes || 0;
        const percent = Math.min(100, percentage(documentsCount, REQUIRED_DOCS.length));
        bar.style.width = `${percent}%`;
        text.textContent = `SQLite + server file store active · ${documentsCount} document${documentsCount === 1 ? '' : 's'} · ${formatBytes(documentBytes)}`;
        return;
      } catch (error) {
        console.warn('Failed to refresh persistence health', error);
      }
    }

    if (persistenceBackend === 'firebase') {
      const documentsCount = APP_STATE.documents.length;
      const documentBytes = APP_STATE.documents.reduce((total, document) => total + (Number(document.size) || 0), 0);
      const percent = Math.min(100, percentage(documentsCount, REQUIRED_DOCS.length));
      bar.style.width = `${percent}%`;
      text.textContent = `Firebase encrypted vault active · ${documentsCount} document${documentsCount === 1 ? '' : 's'} · ${formatBytes(documentBytes)}`;
      return;
    }

    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 1 } = await navigator.storage.estimate().catch(() => ({}));
      const percent = quota ? Math.round((usage / quota) * 100) : 0;
      bar.style.width = `${percent}%`;
      text.textContent = `Browser fallback storage active · ${formatBytes(usage)} / ${formatBytes(quota || 0)}`;
      return;
    }

    bar.style.width = '0%';
    text.textContent = 'Browser fallback storage active';
  }

  function showValidationSummary(prefix, issues) {
    if (!issues.length) return;
    const first = issues[0];
    const remainder = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
    showToast(`${prefix}: ${first}${remainder}`, 'error');
  }

  function validateApplicationReadiness() {
    syncStateFromDom();
    const personal = validatePersonalSection();
    const employment = validateEmploymentSection();
    const address = validateAddressSection();
    const family = validateFamilySection();
    const financial = validateFinancialSection();
    const disclosure = validateDisclosureSection();

    const issues = [
      ...personal.issues,
      ...employment.issues,
      ...address.issues,
      ...family.issues,
      ...financial.issues,
      ...disclosure.issues
    ];
    const warnings = [...employment.warnings, ...address.warnings];

    const uploadedCategories = new Set(APP_STATE.documents.map((document) => document.category));
    const missingMandatory = REQUIRED_DOCS.filter((document) => document.mandatory && !uploadedCategories.has(document.id));
    if (missingMandatory.length > 0) {
      issues.push(`Missing mandatory documents: ${missingMandatory.map((document) => document.name).join(', ')}`);
    }

    if (!APP_STATE.referees.length) {
      issues.push('At least one eligible referee is required.');
    } else {
      APP_STATE.referees.forEach((referee) => {
        const result = validateRefereeAGSVA(referee);
        if (!result.valid) issues.push(`${referee.name}: ${result.errors.join('; ')}`);
      });
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings
    };
  }

  function savePersonalInfo() {
    const validation = validatePersonalSection({ markFields: true });
    syncStateFromDom();
    if (!validation.valid) {
      showValidationSummary('Personal information requires attention', validation.issues);
      return;
    }
    queuePersist(true);
    updateAllProgress();
    showToast('✅ Personal information saved', 'success');
  }

  function saveDisclosure() {
    const validation = validateDisclosureSection({ markFields: true });
    syncStateFromDom();
    if (!validation.valid) {
      showValidationSummary('Disclosure statement requires attention', validation.issues);
      return;
    }
    queuePersist(true);
    updateAllProgress();
    showToast('✅ Disclosure statement saved', 'success');
  }

  function validateDisclosure() {
    const validation = validateDisclosureSection({ markFields: true });
    syncStateFromDom();
    if (!validation.valid) {
      showValidationSummary('Disclosure validation failed', validation.issues);
      return;
    }
    queuePersist(true);
    updateAllProgress();
    showToast('✅ Disclosure statement passes all validation checks', 'success');
  }

  function saveFinancial() {
    const validation = validateFinancialSection({ markFields: true });
    syncStateFromDom();
    if (!validation.valid) {
      showValidationSummary('Financial details require attention', validation.issues);
      return;
    }
    queuePersist(true);
    updateAllProgress();
    showToast('✅ Financial information saved', 'success');
  }

  function validateReferee() {
    const candidate = collectRefereeCandidate();
    const validation = validateRefereeCandidate(candidate, { markFields: true });
    if (!validation.valid) {
      showValidationSummary('Referee validation failed', validation.issues);
      return;
    }
    validation.warnings.forEach((warning, index) => {
      window.setTimeout(() => showToast(`⚠️ ${warning}`, 'info'), index * 500);
    });
    showToast('✅ Referee meets AGSVA Baseline eligibility requirements', 'success');
  }

  function addReferee() {
    const candidate = collectRefereeCandidate();
    const validation = validateRefereeCandidate(candidate, { markFields: true });
    if (!validation.valid) {
      showValidationSummary('Referee validation failed', validation.issues);
      return;
    }

    candidate.eligible = true;
    APP_STATE.referees.push(candidate);
    clearRefereeForm();
    syncStateFromDom();
    renderRefereeCards();
    updateAllProgress();
    queuePersist(true);

    validation.warnings.forEach((warning, index) => {
      window.setTimeout(() => showToast(`⚠️ ${warning}`, 'info'), index * 400);
    });
    showToast(`✅ ${candidate.name} added — AGSVA validation passed`, 'success');
  }

  function removeReferee(index) {
    const referee = APP_STATE.referees[index];
    if (!referee) return;
    APP_STATE.referees.splice(index, 1);
    syncStateFromDom();
    renderRefereeCards();
    updateAllProgress();
    queuePersist(true);
    showToast(`Referee removed: ${referee.name}`, 'info');
  }

  function renderRefereeCards() {
    const container = getElement('referee-cards');
    if (!container) return;

    if (!APP_STATE.referees.length) {
      container.innerHTML = '<div class="info-banner" style="grid-column:1/-1;"><span class="info-banner-icon">ℹ️</span><span>No referees nominated yet. Complete the form above and click "Add Referee".</span></div>';
      return;
    }

    container.innerHTML = '';
    APP_STATE.referees.forEach((referee, index) => {
      const card = document.createElement('div');
      card.className = `referee-card ${referee.eligible ? 'eligible' : 'pending'}`;
      card.setAttribute('role', 'listitem');
      card.innerHTML = `
        <div class="referee-card-name">${escapeHtml(referee.name)}</div>
        <div class="referee-card-role">${escapeHtml(referee.role)} · ${escapeHtml(referee.employer)}</div>
        <span class="badge ${referee.eligible ? 'badge-complete' : 'badge-pending'}">${referee.eligible ? 'Eligible' : 'Check Eligibility'}</span>
        <div class="referee-card-meta mt-2">
          <div class="referee-meta-item">📧 ${escapeHtml(referee.email || 'Not provided')}</div>
          <div class="referee-meta-item">📞 ${escapeHtml(referee.phone || 'Not provided')}</div>
          <div class="referee-meta-item">🗓️ ${escapeHtml(formatMonthDisplay(referee.from))}${referee.to ? ` – ${escapeHtml(formatMonthDisplay(referee.to))}` : ' – Present'}</div>
        </div>
        <div class="referee-card-actions">
          <button class="btn btn-primary btn-sm" onclick="generateRefereePDF(${index})" aria-label="Generate briefing PDF for ${escapeHtml(referee.name)}">Generate Briefing</button>
          <button class="btn btn-ghost btn-sm" onclick="removeReferee(${index})" aria-label="Remove ${escapeHtml(referee.name)}">Remove</button>
        </div>
      `;
      container.appendChild(card);
    });
  }

  function buildDynamicEntryHeader(title, removeLabel, section) {
    return `
      <div class="timeline-entry-header">
        <span class="timeline-entry-title">${title}</span>
        <button class="btn btn-ghost btn-sm" onclick="removeDynamicEntry(this, '${section}')" aria-label="${removeLabel}">Remove</button>
      </div>
    `;
  }

  function removeDynamicEntry(button) {
    const entry = button?.closest('.timeline-entry');
    if (!entry) return;
    entry.remove();
    syncStateFromDom();
    updateAllProgress();
    queuePersist(true);
  }

  function addEmploymentEntry(shouldPersist = true) {
    const container = getElement('employment-entries');
    if (!container) return;
    const slot = empCount++;
    const entry = document.createElement('div');
    entry.className = 'timeline-entry';
    entry.setAttribute('role', 'listitem');
    entry.innerHTML = `
      ${buildDynamicEntryHeader(`Employment Entry ${slot}`, 'Remove this employment entry', 'employment')}
      <div class="form-grid">
        <div class="form-field"><label class="form-label" for="emp${slot}-employer">Employer Name <span class="req">*</span></label><input class="form-input" type="text" id="emp${slot}-employer" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="emp${slot}-position">Position Title <span class="req">*</span></label><input class="form-input" type="text" id="emp${slot}-position" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="emp${slot}-start">Start Date <span class="req">*</span></label><input class="form-input" type="month" id="emp${slot}-start" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="emp${slot}-end">End Date</label><input class="form-input" type="month" id="emp${slot}-end"></div>
        <div class="form-field form-col-2"><label class="form-label" for="emp${slot}-addr">Employer Address <span class="req">*</span></label><input class="form-input" type="text" id="emp${slot}-addr" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="emp${slot}-supervisor">Supervisor Name <span class="req">*</span></label><input class="form-input" type="text" id="emp${slot}-supervisor" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="emp${slot}-sup-phone">Supervisor Phone <span class="req">*</span></label><input class="form-input" type="tel" id="emp${slot}-sup-phone" aria-required="true"></div>
      </div>
    `;
    container.appendChild(entry);
    if (shouldPersist) {
      syncStateFromDom();
      updateAllProgress();
      queuePersist(true);
    }
  }

  function addAddressEntry(shouldPersist = true) {
    const container = getElement('address-entries');
    if (!container) return;
    const slot = addrCount++;
    const entry = document.createElement('div');
    entry.className = 'timeline-entry';
    entry.setAttribute('role', 'listitem');
    entry.innerHTML = `
      ${buildDynamicEntryHeader(`Previous Address ${slot - 1}`, 'Remove this address entry', 'address')}
      <div class="form-grid">
        <div class="form-field form-col-2"><label class="form-label" for="addr${slot}-street">Street Address <span class="req">*</span></label><input class="form-input" type="text" id="addr${slot}-street" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="addr${slot}-suburb">Suburb <span class="req">*</span></label><input class="form-input" type="text" id="addr${slot}-suburb" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="addr${slot}-state">State <span class="req">*</span></label><select class="form-select" id="addr${slot}-state" aria-required="true"><option value="">Select</option><option value="VIC">Victoria</option><option value="NSW">NSW</option><option value="QLD">Queensland</option><option value="SA">South Australia</option><option value="WA">Western Australia</option><option value="TAS">Tasmania</option><option value="ACT">ACT</option><option value="NT">NT</option></select></div>
        <div class="form-field"><label class="form-label" for="addr${slot}-from">Date From <span class="req">*</span></label><input class="form-input" type="month" id="addr${slot}-from" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="addr${slot}-to">Date To</label><input class="form-input" type="month" id="addr${slot}-to"></div>
      </div>
    `;
    container.appendChild(entry);
    if (shouldPersist) {
      syncStateFromDom();
      updateAllProgress();
      queuePersist(true);
    }
  }

  function addChildEntry(shouldPersist = true) {
    const container = getElement('children-entries');
    if (!container) return;
    const slot = childCount++;
    const entry = document.createElement('div');
    entry.className = 'timeline-entry mt-2';
    entry.setAttribute('role', 'listitem');
    entry.innerHTML = `
      ${buildDynamicEntryHeader(`Child ${slot}`, 'Remove child entry', 'child')}
      <div class="form-grid">
        <div class="form-field"><label class="form-label" for="child${slot}-name">Full Name <span class="req">*</span></label><input class="form-input" type="text" id="child${slot}-name" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="child${slot}-dob">Date of Birth <span class="req">*</span></label><input class="form-input" type="date" id="child${slot}-dob" aria-required="true"></div>
        <div class="form-field"><label class="form-label" for="child${slot}-citizenship">Citizenship</label><input class="form-input" type="text" id="child${slot}-citizenship" placeholder="e.g. Australian"></div>
      </div>
    `;
    container.appendChild(entry);
    if (shouldPersist) {
      syncStateFromDom();
      updateAllProgress();
      queuePersist(true);
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',')[1] : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
      reader.readAsDataURL(file);
    });
  }

  async function processFiles(fileList) {
    if (persistenceBackend === 'browser') {
      if (getElement('file-input')) getElement('file-input').value = '';
      if (legacyProcessFiles) return legacyProcessFiles(fileList);
      return;
    }

    const categoryElement = getElement('upload-category');
    const manualCategory = categoryElement ? categoryElement.value : '';
    for (const file of Array.from(fileList || [])) {
      if (!VALID_DOCUMENT_TYPES.has(file.type)) {
        showToast(`❌ ${file.name} — unsupported format (PDF, JPEG, PNG only)`, 'error');
        continue;
      }
      if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
        showToast(`❌ ${file.name} — exceeds 10MB limit (${formatBytes(file.size)})`, 'error');
        continue;
      }

      const category = manualCategory || inferCategory(file.name);
      const existing = APP_STATE.documents.filter((document) => document.category === category);
      const contentBase64 = await fileToBase64(file);
      const validationState = validateDocumentFile(file, category);
      let storedDocument = null;

      if (persistenceBackend === 'firebase') {
        storedDocument = await storeFirebaseDocument(file, category, validationState, contentBase64);
        for (const document of existing) {
          await deleteFirebaseDocument(document);
        }
      } else {
        for (const document of existing) {
          await fetch(`${SERVER_DOCUMENT_ENDPOINT}/${encodeURIComponent(document.id)}`, { method: 'DELETE' }).catch(() => {});
        }
        const payload = await apiJson(SERVER_DOCUMENT_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            type: file.type,
            size: file.size,
            category,
            validationState,
            contentBase64
          })
        });
        storedDocument = payload.document;
      }

      APP_STATE.documents = APP_STATE.documents.filter((document) => document.category !== category);
      APP_STATE.documents.unshift(storedDocument);
      renderUploadedDocs();
      renderDocChecklist();
      updateDocumentProgress();
      queuePersist(true);
      updateStorageMeter();
      showToast(`✅ ${file.name} stored (${getCategoryLabel(category)})`, 'success');
    }

    if (getElement('file-input')) getElement('file-input').value = '';
  }

  async function previewDoc(id) {
    if (persistenceBackend === 'browser') {
      if (legacyPreviewDoc) return legacyPreviewDoc(id);
      return;
    }
    if (persistenceBackend === 'firebase') {
      const documentRecord = APP_STATE.documents.find((document) => document.id === id);
      if (!documentRecord) return;
      return openFirebaseDocument(documentRecord);
    }
    window.open(`${SERVER_DOCUMENT_ENDPOINT}/${encodeURIComponent(id)}/content`, '_blank', 'noopener');
  }

  async function removeDoc(id) {
    if (persistenceBackend === 'browser') {
      if (legacyRemoveDoc) return legacyRemoveDoc(id);
      return;
    }

    if (persistenceBackend === 'firebase') {
      const documentRecord = APP_STATE.documents.find((document) => document.id === id);
      if (documentRecord) await deleteFirebaseDocument(documentRecord);
    } else {
      await fetch(`${SERVER_DOCUMENT_ENDPOINT}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    APP_STATE.documents = APP_STATE.documents.filter((document) => document.id !== id);
    renderUploadedDocs();
    renderDocChecklist();
    updateDocumentProgress();
    queuePersist(true);
    updateStorageMeter();
  }

  function updateSubmissionChecklist() {
    const container = getElement('submission-checklist');
    const statusElement = getElement('checklist-status');
    if (!container || !statusElement) return;

    const readiness = validateApplicationReadiness();
    const items = [
      { label: 'Personal information complete', done: APP_STATE.progress.personal >= 100 },
      { label: '5-year employment history documented', done: APP_STATE.progress.employment >= 80 && validateEmploymentSection().valid },
      { label: '5-year address history documented', done: APP_STATE.progress.address >= 80 && validateAddressSection().valid },
      { label: 'Mandatory identity documents uploaded', done: APP_STATE.progress.documents >= 80 },
      { label: 'At least 1 eligible referee nominated', done: APP_STATE.referees.some((referee) => referee.eligible) },
      { label: 'Referee briefing PDF generated', done: Boolean(APP_STATE.meta.refereePdfGeneratedAt) },
      { label: 'Legal proceedings disclosure completed', done: validateDisclosureSection().valid },
      { label: 'Financial information provided', done: validateFinancialSection().valid }
    ];

    const remaining = items.filter((item) => !item.done).length;
    statusElement.textContent = remaining === 0 && readiness.ready ? '✅ Ready to Submit' : `${remaining} Item${remaining === 1 ? '' : 's'} Remaining`;
    statusElement.className = `badge ${remaining === 0 && readiness.ready ? 'badge-complete' : 'badge-pending'}`;

    container.innerHTML = items.map((item) => `
      <div class="action-item" role="listitem">
        <div class="action-icon ${item.done ? 'info' : 'critical'}" aria-hidden="true">${item.done ? '✅' : '⭕'}</div>
        <div class="action-text">
          <div class="action-title" style="color:${item.done ? 'var(--success)' : 'var(--text-primary)'}">${escapeHtml(item.label)}</div>
        </div>
      </div>
    `).join('');
  }

  function addPdfFooter(pdf, pageWidth, pageHeight, margin, leftText, rightText) {
    const pageCount = pdf.internal.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      pdf.setPage(pageNumber);
      pdf.setDrawColor(20, 82, 89);
      pdf.setLineWidth(0.3);
      pdf.line(margin, pageHeight - 14, pageWidth - margin, pageHeight - 14);
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(120, 120, 120);
      pdf.text(leftText, margin, pageHeight - 9);
      pdf.text(`Page ${pageNumber} of ${pageCount}`, pageWidth / 2, pageHeight - 9, { align: 'center' });
      pdf.text(rightText, pageWidth - margin, pageHeight - 9, { align: 'right' });
    }
  }

  function generateRefereePDF(refereeIndex = 0) {
    if (typeof window.jspdf === 'undefined') {
      showToast('⚠️ PDF library loading — please wait and try again', 'info');
      return;
    }

    const button = getElement('generate-pdf-btn');
    if (button) {
      button.innerHTML = '<span class="spinner"></span> Generating...';
      button.disabled = true;
    }

    try {
      syncStateFromDom();
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = 210;
      const pageHeight = 297;
      const margin = 20;
      const primary = [20, 82, 89];
      const accent = [50, 184, 198];
      const textColor = [31, 33, 33];
      const gray = [245, 245, 245];
      const referee = APP_STATE.referees[refereeIndex] || { name: '[Referee Name]', role: 'Supervisor', employer: 'Organisation', email: '', phone: '' };
      const applicantName = APP_STATE.personal?.fullName || 'Vikram Deshpande';
      const issuedDate = new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' });

      function drawHeader() {
        pdf.setFillColor(...primary);
        pdf.rect(0, 0, pageWidth, 58, 'F');
        pdf.setDrawColor(...accent);
        pdf.setLineWidth(0.8);
        pdf.line(margin, 56, pageWidth - margin, 56);
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'normal');
        pdf.text('AUSTRALIAN GOVERNMENT SECURITY VETTING AGENCY', pageWidth / 2, 14, { align: 'center' });
        pdf.setFontSize(20);
        pdf.setFont('helvetica', 'bold');
        pdf.text('SECURITY CLEARANCE', pageWidth / 2, 30, { align: 'center' });
        pdf.text('REFEREE BRIEFING PACKAGE', pageWidth / 2, 44, { align: 'center' });
        pdf.setTextColor(...textColor);
      }

      function sectionTitle(title, y) {
        pdf.setFillColor(...gray);
        pdf.rect(margin, y - 5, pageWidth - (margin * 2), 10, 'F');
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(...primary);
        pdf.text(title, margin + 4, y + 2);
        return y + 12;
      }

      function bodyText(text, y, maxWidth = pageWidth - (margin * 2) - 4) {
        const wrapped = Array.isArray(text)
          ? text.flatMap((line) => line ? pdf.splitTextToSize(line, maxWidth) : [''])
          : pdf.splitTextToSize(text, maxWidth);
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...textColor);
        pdf.text(wrapped, margin + 4, y);
        return y + (wrapped.length * 5.5);
      }

      function wrappedLabelValue(label, value, y) {
        const labelWidth = 34;
        const wrapped = pdf.splitTextToSize(value || 'Not provided', pageWidth - (margin * 2) - labelWidth - 10);
        pdf.setFontSize(12);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(...primary);
        pdf.text(label, margin + 8, y);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(...textColor);
        pdf.text(wrapped, margin + 44, y);
        return y + Math.max(10, wrapped.length * 5.5);
      }

      drawHeader();
      pdf.setFillColor(...gray);
      pdf.rect(margin, 68, pageWidth - (margin * 2), 44, 'F');
      let y = 80;
      y = wrappedLabelValue('APPLICANT:', applicantName, y);
      y = wrappedLabelValue('REFEREE:', referee.name, y + 2);
      wrappedLabelValue('CLEARANCE:', 'Baseline — Australian Taxation Office (ATO)', y + 2);

      y = 126;
      y = sectionTitle('DOCUMENT INFORMATION', y);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...textColor);
      pdf.text(`Date Issued: ${issuedDate}`, margin + 4, y); y += 6;
      pdf.text('Referee Report Valid For: 15 business days from AGSVA dispatch', margin + 4, y); y += 6;
      pdf.text('Classification: CONFIDENTIAL — For Referee Use Only', margin + 4, y); y += 14;
      y = sectionTitle('PURPOSE OF THIS DOCUMENT', y);
      bodyText(
        `${applicantName} has nominated you as a professional referee for their AGSVA Baseline Security Clearance application. ` +
        `This clearance is required for a position with the Australian Taxation Office (ATO) requiring access to PROTECTED classified information.\n\n` +
        `As a referee, AGSVA may contact you to verify information and provide an assessment of the applicant's character, ` +
        `trustworthiness, and professional suitability. Your cooperation and prompt response are greatly appreciated.`,
        y
      );

      pdf.addPage();
      y = 20;
      y = sectionTitle('APPLICANT PROFESSIONAL PROFILE', y);
      y = bodyText(
        `${applicantName} is a highly experienced technology professional with a 20-year career spanning senior technical leadership roles ` +
        `in both civilian and government-adjacent sectors. They demonstrate consistent delivery in complex, security-sensitive technical environments.`,
        y
      );
      y += 4;
      y = sectionTitle('KEY PROFESSIONAL ATTRIBUTES', y);
      [
        '• 20-year unblemished career history in technical leadership roles',
        '• Senior Technical Leader managing high-value, security-critical projects',
        '• Annual remuneration: $200,000+ AUD (Senior Leadership tier)',
        '• Expertise: Full-stack development, AI systems, DevOps, infrastructure management',
        '• Experience with security-sensitive government contracts and compliance frameworks',
        '• Demonstrated professional integrity and consistent reliability throughout career'
      ].forEach((line) => { y = bodyText(line, y); });
      y += 4;
      y = sectionTitle('AGSVA BASELINE CLEARANCE CONTEXT', y);
      bodyText(
        `A Baseline Security Clearance authorises access to OFFICIAL and PROTECTED classified information. ` +
        `AGSVA assesses applicants based on core personal qualities: honesty, integrity, trustworthiness, maturity, sound judgment, ` +
        `tolerance, resilience, and loyalty to Australia. ${applicantName}'s 20-year professional history provides strong evidence of these qualities.`,
        y
      );

      pdf.addPage();
      y = 20;
      y = sectionTitle('YOUR ROLE AS A REFEREE', y);
      y = bodyText('As a nominated referee, AGSVA may contact you via one or more of the following methods:', y);
      y = bodyText([
        '1. ONLINE REPORT: You will receive an email with a unique secure link to complete a standardised online questionnaire.',
        '   This report typically takes 15–45 minutes and must be completed within 15 business days.',
        '',
        '2. PHONE INTERVIEW: An AGSVA vetting officer may call to discuss your responses or seek clarification.',
        '',
        '3. WRITTEN CORRESPONDENCE: Additional questions may be sent via email.'
      ], y);
      y += 6;
      y = sectionTitle('TYPICAL REFEREE QUESTIONS', y);
      y = bodyText('AGSVA referees are typically asked to comment on the following aspects of the applicant\'s character and conduct:', y);
      [
        '• Nature, duration and context of your professional relationship',
        '• Applicant\'s honesty, integrity, and ethical conduct',
        '• Professional reliability, competence, and work ethic',
        '• Ability to handle confidential or sensitive information responsibly',
        '• Sound judgment and maturity in professional situations',
        '• Any concerns about suitability for a security clearance (answer honestly)',
        '• Financial responsibility (if within your knowledge)'
      ].forEach((line) => { y = bodyText(line, y); });
      y += 4;
      const timingText = pdf.splitTextToSize(
        `Referee responsiveness is a primary cause of clearance processing delays. Please respond to AGSVA within 5 business days ` +
        `of receiving the request to ensure ${applicantName}'s application is processed efficiently.`,
        pageWidth - (margin * 2) - 8
      );
      const timingHeight = 12 + (timingText.length * 5.5);
      pdf.setFillColor(255, 250, 240);
      pdf.rect(margin, y, pageWidth - (margin * 2), timingHeight, 'F');
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...primary);
      pdf.text('IMPORTANT — TIMING:', margin + 4, y + 7);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...textColor);
      pdf.text(timingText, margin + 4, y + 12);

      pdf.addPage();
      y = 20;
      y = sectionTitle('CHARACTER REFERENCE TEMPLATE', y);
      y = bodyText('The following is a suggested template. Please customise based on your direct knowledge and experience:', y);
      y += 4;
      const templateLines = [
        'To: Australian Government Security Vetting Agency',
        `Re: Security Clearance Reference — ${applicantName}`,
        '',
        `I am writing to provide a professional reference for ${applicantName}, who has nominated me`,
        'as a referee for their AGSVA Baseline Security Clearance application.',
        '',
        `I have known ${applicantName} in the capacity of [relationship] for [duration].`,
        'During this time I have observed their professional conduct closely.',
        '',
        `${applicantName} consistently demonstrates [honesty/integrity/reliability — customise].`,
        'In their role as [position], they have shown [specific examples — customise].',
        '',
        `I believe ${applicantName} is well-suited to hold a security clearance and handle`,
        'protected information with the appropriate level of discretion and responsibility.',
        '',
        'I am available to discuss this reference further if required.',
        '',
        'Sincerely,',
        referee.name,
        `${referee.role} · ${referee.employer}`
      ];
      const templateHeight = Math.max(130, 12 + (templateLines.length * 5.2));
      pdf.setFillColor(249, 252, 253);
      pdf.rect(margin, y, pageWidth - (margin * 2), templateHeight, 'F');
      pdf.setDrawColor(...accent);
      pdf.setLineWidth(0.5);
      pdf.rect(margin, y, pageWidth - (margin * 2), templateHeight, 'S');
      y += 6;
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...textColor);
      templateLines.forEach((line) => {
        const wrapped = pdf.splitTextToSize(line, pageWidth - (margin * 2) - 12);
        pdf.text(wrapped, margin + 6, y);
        y += Math.max(5.2, wrapped.length * 5.2);
      });

      pdf.addPage();
      y = 20;
      y = sectionTitle('AGSVA CONTACT INFORMATION', y);
      ['Phone:   1800 640 450', 'Email:   securityclearances@defence.gov.au', 'Website: www.agsva.gov.au', 'Portal:  myClearance (online clearance management system)', 'Hours:   Monday – Friday, 8:30 AM – 5:00 PM AEST']
        .forEach((line) => { y = bodyText(line, y); });
      y += 8;
      y = sectionTitle('ADDITIONAL RESOURCES', y);
      ['• Referee information: www.agsva.gov.au/applicants/referees', '• Assessment process: www.agsva.gov.au/applicants/assessment-process', '• What to expect guide: www.agsva.gov.au (PDF guides available)']
        .forEach((line) => { y = bodyText(line, y); });
      y += 8;
      const thankYouText = pdf.splitTextToSize(
        `Your cooperation as a referee is greatly appreciated. Your honest, timely response is vital ` +
        `to ensuring ${applicantName}'s clearance application is assessed efficiently and fairly.`,
        pageWidth - (margin * 2) - 12
      );
      const thankYouHeight = 16 + (thankYouText.length * 5.5);
      pdf.setFillColor(240, 252, 254);
      pdf.rect(margin, y, pageWidth - (margin * 2), thankYouHeight, 'F');
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...primary);
      pdf.text('Thank You', margin + 6, y + 10);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...textColor);
      pdf.text(thankYouText, margin + 6, y + 16);

      addPdfFooter(pdf, pageWidth, pageHeight, margin, 'CONFIDENTIAL', 'AGSVA Referee Briefing');
      pdf.save(`AGSVA_Referee_Briefing_${applicantName.replace(/\s+/g, '_')}_${Date.now()}.pdf`);

      APP_STATE.meta.refereePdfGeneratedAt = new Date().toISOString();
      updateAllProgress();
      queuePersist(true);
      showToast('✅ Referee briefing PDF downloaded successfully', 'success');
    } catch (error) {
      console.error('Referee PDF generation failed', error);
      showToast('❌ Unable to generate the referee briefing PDF', 'error');
    } finally {
      if (button) {
        button.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Generate Professional Referee Briefing PDF';
        button.disabled = false;
      }
    }
  }

  function exportApplicationPDF() {
    if (typeof window.jspdf === 'undefined') {
      showToast('PDF library loading...', 'info');
      return;
    }

    syncStateFromDom();
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 20;
    const primary = [20, 82, 89];
    const textColor = [31, 33, 33];
    const accent = [50, 184, 198];
    let y = 65;

    function drawHeader() {
      pdf.setFillColor(...primary);
      pdf.rect(0, 0, pageWidth, 50, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('AGSVA BASELINE CLEARANCE APPLICATION', pageWidth / 2, 22, { align: 'center' });
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`Applicant: ${APP_STATE.personal?.fullName || 'Vikram Deshpande'} · ATO · ${new Date().toLocaleDateString('en-AU')}`, pageWidth / 2, 36, { align: 'center' });
      pdf.setTextColor(...textColor);
      y = 65;
    }

    function ensureSpace(requiredHeight) {
      if (y + requiredHeight <= pageHeight - 20) return;
      pdf.addPage();
      drawHeader();
    }

    function sectionTitle(title) {
      ensureSpace(14);
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...primary);
      pdf.text(title, margin, y);
      y += 8;
      pdf.setTextColor(...textColor);
    }

    function wrappedParagraph(text, indent = 0) {
      const lines = pdf.splitTextToSize(text, pageWidth - (margin * 2) - indent);
      ensureSpace(Math.max(8, lines.length * 5.5));
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.text(lines, margin + indent, y);
      y += Math.max(6, lines.length * 5.5);
    }

    drawHeader();

    sectionTitle('APPLICATION PROGRESS SUMMARY');
    Object.entries(APP_STATE.progress).forEach(([key, value]) => {
      ensureSpace(8);
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      pdf.setFontSize(10);
      pdf.text(`${label.padEnd(20)}: ${value}%`, margin, y);
      pdf.setFillColor(value >= 80 ? 33 : value >= 50 ? 168 : 192, value >= 80 ? 141 : value >= 50 ? 75 : 21, value >= 80 ? 141 : value >= 50 ? 47 : 47);
      pdf.rect(margin + 80, y - 4, (pageWidth - (margin * 2) - 84) * (value / 100), 4, 'F');
      pdf.setFillColor(226, 229, 227);
      pdf.rect(margin + 80 + ((pageWidth - (margin * 2) - 84) * (value / 100)), y - 4, (pageWidth - (margin * 2) - 84) * (1 - (value / 100)), 4, 'F');
      y += 7;
    });

    sectionTitle('DOCUMENTS UPLOADED');
    if (APP_STATE.documents.length === 0) {
      wrappedParagraph('No documents uploaded yet.');
    } else {
      APP_STATE.documents.forEach((document) => {
        wrappedParagraph(`• ${document.name} (${String(document.type || '').split('/')[1]?.toUpperCase() || 'FILE'})`);
      });
    }

    sectionTitle('REFEREES NOMINATED');
    if (APP_STATE.referees.length === 0) {
      wrappedParagraph('No referees nominated yet.');
    } else {
      APP_STATE.referees.forEach((referee) => {
        wrappedParagraph(`• ${referee.name} — ${referee.role} at ${referee.employer} (${referee.eligible ? 'Eligible' : 'Check'})`);
      });
    }

    sectionTitle('LEGAL PROCEEDINGS DISCLOSURE');
    wrappedParagraph(getFieldValue('disclosure-editor') || 'No disclosure statement captured.');

    addPdfFooter(pdf, pageWidth, pageHeight, margin, 'UNCLASSIFIED', 'AGSVA Clearance Platform');
    pdf.save(`AGSVA_Application_Summary_${(APP_STATE.personal?.fullName || 'Applicant').replace(/\s+/g, '')}_${Date.now()}.pdf`);
    APP_STATE.meta.applicationPdfGeneratedAt = new Date().toISOString();
    queuePersist(true);
    showToast('✅ Application summary PDF downloaded', 'success');
  }

  function initDB() {
    const mode = preferredPersistenceMode();

    if (mode === 'browser') {
      persistenceBackend = 'browser';
      restoreState();
      showToast('ℹ️ Browser-only storage is active.', 'info');
      return;
    }

    if (mode === 'firebase') {
      persistenceBackend = 'firebase';
      hydrateFromFirebase().catch((error) => {
        console.error('Falling back to browser storage after Firebase failure', error);
        persistenceBackend = 'browser';
        restoreState();
        showToast('⚠️ Cloud persistence unavailable. Browser fallback storage is active.', 'info');
      });
      return;
    }

    hydrateFromServer().catch((error) => {
      console.info('Falling back to browser storage', error);
      persistenceBackend = 'browser';
      restoreState();
      showToast('ℹ️ Server persistence unavailable. Browser fallback storage is active.', 'info');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
      if (target.type === 'file') return;
      if (persistenceHydrating) return;
      setFieldValidationState(target.id, '');
      syncStateFromDom();
      updateAllProgress();
      autoSave();
    });

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
      if (target.type === 'file') return;
      if (persistenceHydrating) return;
      syncStateFromDom();
      updateAllProgress();
      autoSave();
    });
  });

  window.restoreState = restoreState;
  window.autoSave = autoSave;
  window.updateStorageMeter = updateStorageMeter;
  window.validateApplicationReadiness = validateApplicationReadiness;
  window.savePersonalInfo = savePersonalInfo;
  window.saveDisclosure = saveDisclosure;
  window.validateDisclosure = validateDisclosure;
  window.saveFinancial = saveFinancial;
  window.validateReferee = validateReferee;
  window.addReferee = addReferee;
  window.removeReferee = removeReferee;
  window.renderRefereeCards = renderRefereeCards;
  window.addEmploymentEntry = addEmploymentEntry;
  window.addAddressEntry = addAddressEntry;
  window.addChildEntry = addChildEntry;
  window.removeDynamicEntry = removeDynamicEntry;
  window.processFiles = processFiles;
  window.handleFileSelect = function handleFileSelectOverride(event) {
    return processFiles(event?.target?.files || []);
  };
  window.handleDrop = function handleDropOverride(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove('dragover');
    return processFiles(event?.dataTransfer?.files || []);
  };
  window.previewDoc = previewDoc;
  window.removeDoc = removeDoc;
  window.generateRefereePDF = generateRefereePDF;
  window.exportApplicationPDF = exportApplicationPDF;
  window.initDB = initDB;
  window.updateSubmissionChecklist = updateSubmissionChecklist;
  window.__agsvaPersistenceState = function persistenceState() {
    return {
      backend: persistenceBackend,
      ready: persistenceReady,
      hydrating: persistenceHydrating
    };
  };
  window.__agsvaPersistenceDiagnostics = function persistenceStateDiagnostics() {
    return { ...persistenceDiagnostics };
  };
