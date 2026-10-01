import { useEffect, useMemo, useState, type FormEvent } from 'react';
const api = {
  async request(method: string, url: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetch(url, { credentials: 'include', method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Could not reach the FieldMind backend. Check the deployment and try again.');
    }
    const raw = await response.text().catch(() => '');
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(data?.message || ('Request failed (' + response.status + ')'));
    }
    return { data };
  },
  get(url: string) { return this.request('GET', url); },
  post(url: string, body?: unknown) { return this.request('POST', url, body); },
  put(url: string, body?: unknown) { return this.request('PUT', url, body); },
  delete(url: string) { return this.request('DELETE', url); },
};
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Database,
  Eye,
  EyeOff,
  FileCheck2,
  FileSpreadsheet,
  FlaskConical,
  Globe2,
  Layers3,
  Link2,
  LockKeyhole,
  LogOut,
  Mail,
  UserRound,
  ArrowUpRight,
  Menu,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';

type AuthUser = { id: string; email: string; isAdmin: boolean };

type Project = {
  id: string;
  name: string;
  location: string;
  topic: string;
  koboUrl: string;
  formStatus: string;
  offlineReady: boolean;
  researchCount: number;
  draftCount: number;
  approvedCount: number;
  updatedAt: string;
};

type Source = {
  id: string;
  title: string;
  facility: string;
  year: number;
  type: string;
  finding: string;
};

type DraftField = {
  name: string;
  label: string;
  value: string;
  confidence: number;
  evidence: string;
  status: 'review' | 'approved' | 'rejected';
};

type FormField = { name: string; label: string; type: string; required?: boolean; options?: { name: string; label: string }[] };
type Draft = {
  id: string;
  projectId: string;
  label: string;
  mode: 'synthetic';
  fields: DraftField[];
  createdAt: string;
  status?: 'review' | 'confirmed' | 'deployed';
};

const emptyProject: Project = {
  id: '',
  name: 'No project selected',
  location: '',
  topic: '',
  koboUrl: '',
  formStatus: 'Not connected',
  offlineReady: false,
  researchCount: 0,
  draftCount: 0,
  approvedCount: 0,
  updatedAt: '',
};


const WORKSPACE_STORAGE_KEY = 'fieldmind:workspace:v2';
const KOBO_TOKEN_STORAGE_KEY = 'fieldmind:kobo-token:v2';

function readKoboTokenStorage() {
  if (typeof window === 'undefined') return '';
  try {
    const saved = window.localStorage.getItem(KOBO_TOKEN_STORAGE_KEY) || '';
    if (saved) return saved;
    // Migrate the previous tab-scoped token once.
    const legacy = window.sessionStorage.getItem('fieldmind:kobo-token:v1') || '';
    if (legacy) {
      window.localStorage.setItem(KOBO_TOKEN_STORAGE_KEY, legacy);
      return legacy;
    }
    return '';
  } catch {
    return '';
  }
}

function writeKoboTokenStorage(value: string) {
  try {
    if (value) window.localStorage.setItem(KOBO_TOKEN_STORAGE_KEY, value);
    else window.localStorage.removeItem(KOBO_TOKEN_STORAGE_KEY);
  } catch {}
}

type WorkspaceSnapshot = {
  version: 2;
  savedAt: string;
  page: string;
  projects: Project[];
  sources: Source[];
  drafts: Draft[];
  selectedProject: Project;
  fields: FormField[];
  koboUrl: string;
  koboState: { checked: boolean; offline: boolean; title: string; questionCount: number; error: string };
  koboCandidates: { uid: string; name: string; url: string }[];
  koboCandidateUid: string;
  draftCount: number;
  ageMix: string;
  majority: string;
};

function readWorkspaceSnapshot(): Partial<WorkspaceSnapshot> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

const nav = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'projects', label: 'Projects', icon: Layers3 },
  { key: 'research', label: 'Research library', icon: BookOpen },
  { key: 'review', label: 'Review queue', icon: ClipboardCheck },
  { key: 'export', label: 'Export', icon: FileSpreadsheet },
];

function App() {
  const cached: Partial<WorkspaceSnapshot> | null = null;
  const [authStatus, setAuthStatus] = useState<'checking' | 'authenticated' | 'guest'>('checking');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [page, setPage] = useState(() => cached?.page || 'overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>(() => cached?.projects || []);
  const [sources, setSources] = useState<Source[]>(() => cached?.sources || []);
  const [drafts, setDrafts] = useState<Draft[]>(() => cached?.drafts || []);
  const [selectedProject, setSelectedProject] = useState<Project>(() => cached?.selectedProject || emptyProject);
  const [fields, setFields] = useState<FormField[]>(() => cached?.fields || []);
  const [koboUrl, setKoboUrl] = useState(() => cached?.koboUrl || cached?.selectedProject?.koboUrl || '');
  const [koboToken, setKoboToken] = useState(() => readKoboTokenStorage());
  const [showKoboToken, setShowKoboToken] = useState(false);
  const [koboState, setKoboState] = useState(() => cached?.koboState || { checked: false, offline: false, title: 'Not inspected', questionCount: 0, error: '' });
  const [koboCandidates, setKoboCandidates] = useState(() => cached?.koboCandidates || []);
  const [koboCandidateUid, setKoboCandidateUid] = useState(() => cached?.koboCandidateUid || '');
  const [draftCount, setDraftCount] = useState(() => cached?.draftCount || 1);
  const [backendState, setBackendState] = useState<'checking'|'ready'|'error'>('checking');
  const [ageMix, setAgeMix] = useState(() => cached?.ageMix || '18–29: 25% · 30–39: 35% · 40–49: 25% · 50–59: 15%');
  const [majority, setMajority] = useState(() => cached?.majority || 'No directional tendency');
  const [isGenerating, setIsGenerating] = useState(false);
  const [toast, setToast] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [newSource, setNewSource] = useState({ title: '', facility: '', year: String(new Date().getFullYear()), type: 'Literature', finding: '' });
  const [newProject, setNewProject] = useState({
    name: '',
    location: '',
    topic: '',
    koboUrl: '',
  });

  const projectDrafts = useMemo(() => drafts.filter(d => d.projectId === selectedProject.id), [drafts, selectedProject.id]);
  const pending = projectDrafts.filter(d => d.status !== 'confirmed' && d.status !== 'deployed').length;
  const confirmed = projectDrafts.length > 0 && projectDrafts.every(d => d.status === 'confirmed' || d.status === 'deployed');
  const hasRejectedFields = projectDrafts.some(d => d.fields.some(f => f.status === 'rejected'));
  const approved = projectDrafts.reduce((n, d) => n + d.fields.filter(f => f.status === 'approved').length, 0);

  useEffect(() => {
    let alive = true;
    api.get('/api/auth/me').then(result => {
      if (!alive) return;
      setAuthUser(result.data?.user || null);
      setAuthStatus(result.data?.user ? 'authenticated' : 'guest');
      if (!result.data?.user && typeof window !== 'undefined') {
        try { window.localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {}
      }
    }).catch(() => {
      if (!alive) return;
      setAuthUser(null);
      setAuthStatus('guest');
      try { window.localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {}
    });
    return () => { alive = false; };
  }, []);

  // Reconcile the authenticated user's server workspace. The browser cache is
  // no longer used as an authority now that multiple users can share a device.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    let alive = true;
    const cachedProjectId = selectedProject.id;
    const boot = async () => {
      try {
        const health = await api.get('/api/_healthcheck');
        if (!health.data?.ok || health.data?.database !== 'configured' || health.data?.ai !== 'configured') {
          throw new Error('Backend configuration is incomplete.');
        }

        const [projectResult, draftResult] = await Promise.all([
          api.get('/api/projects'),
          api.get('/api/drafts'),
        ]);
        if (!alive) return;

        const loadedProjects = Array.isArray(projectResult.data?.projects) ? projectResult.data.projects : [];
        const loadedDrafts = Array.isArray(draftResult.data?.drafts) ? draftResult.data.drafts : [];
        setProjects(loadedProjects);
        setDrafts(loadedDrafts);

        const preferred = cachedProjectId
          ? loadedProjects.find((project: Project) => project.id === cachedProjectId)
          : undefined;
        const activeProject = preferred || loadedProjects[0];

        if (activeProject) {
          const sameProject = activeProject.id === cachedProjectId;
          setSelectedProject(activeProject);
          setKoboUrl(sameProject && cached?.koboUrl ? cached.koboUrl : (activeProject.koboUrl || ''));

          if (!sameProject) {
            setFields([]);
            setKoboState({ checked: false, offline: false, title: 'Not inspected', questionCount: 0, error: '' });
            setKoboCandidates([]);
            setKoboCandidateUid('');
          }

          try {
            const sourceResult = await api.get('/api/sources?projectId=' + encodeURIComponent(activeProject.id));
            if (alive) {
              setSources(Array.isArray(sourceResult.data?.sources) ? sourceResult.data.sources : []);
            }
          } catch (sourceError) {
            // Keep the cached research library if this one request fails.
            console.warn('FieldMind source refresh failed; keeping cached workspace.', sourceError);
          }
        } else if (!cachedProjectId) {
          setSelectedProject(emptyProject);
          setSources([]);
        }

        setBackendState('ready');
      } catch (e) {
        if (!alive) return;
        // Do not reset projects, drafts, Kobo mapping, page, or selected project.
        // The browser cache is the last known good workspace while the API is down.
        setBackendState('error');
        setToast('Showing your last saved workspace. Backend is currently unavailable.');
      }
    };
    boot();
    return () => { alive = false; };
  }, [authStatus]);

  // Persist a convenience snapshot for the current browser. The server remains
  // the source of truth and ownership is enforced by the authenticated API.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const snapshot: WorkspaceSnapshot = {
        version: 2,
        savedAt: new Date().toISOString(),
        page,
        projects,
        sources,
        drafts,
        selectedProject,
        fields,
        koboUrl,
        koboState,
        koboCandidates,
        koboCandidateUid,
        draftCount,
        ageMix,
        majority,
      };
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('FieldMind workspace cache could not be saved.', error);
    }
  }, [
    page,
    projects,
    sources,
    drafts,
    selectedProject,
    fields,
    koboUrl,
    koboState,
    koboCandidates,
    koboCandidateUid,
    draftCount,
    ageMix,
    majority,
  ]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const checkKobo = async () => {
    setKoboState(s => ({ ...s, checked: false, error: '' }));
    try {
      const result = await api.post('/api/kobo/inspect', {
        url: koboUrl.trim(),
        apiToken: koboToken.trim(),
        ...(koboCandidateUid ? { assetUid: koboCandidateUid } : {}),
      });
      const data = result.data || {};

      if (data.needsSelection) {
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        setKoboCandidates(candidates);
        setKoboCandidateUid(candidates.length === 1 ? candidates[0].uid : '');
        setFields([]);
        setKoboState({
          checked: true,
          offline: false,
          title: 'Select your Kobo project',
          questionCount: 0,
          error: '',
        });
        setToast(candidates.length
          ? 'Kobo link found. Select the matching project, then tap Check again.'
          : 'Kobo accepted the API key but returned no accessible survey projects.');
        return;
      }

      const mapped = Array.isArray(data.fields) ? data.fields : [];
      setKoboCandidates([]);
      setKoboCandidateUid('');
      setFields(mapped);
      setKoboState({
        checked: true,
        offline: Boolean(data.offlineReady),
        title: data.title || 'Kobo form',
        questionCount: mapped.length,
        error: '',
      });

      // Inspection is the source of truth for the UI. Do not throw away a
      // successful Kobo mapping just because the follow-up project save fails.
      // The old flow put this PUT inside the inspection try/catch, so a 404
      // from project persistence immediately cleared the questions that had
      // just been mapped and made it look like Kobo inspection itself failed.
      if (selectedProject.id) {
        const updatedProject = {
          ...selectedProject,
          koboUrl,
          formStatus: mapped.length ? 'Connected' : 'Needs inspection',
          offlineReady: Boolean(data.offlineReady),
          updatedAt: 'Just now',
        };
        try {
          const saved = await api.put('/api/projects/' + selectedProject.id, updatedProject);
          if (saved.data?.project) {
            setSelectedProject(updatedProject);
            setProjects(all => all.map(p => p.id === updatedProject.id ? updatedProject : p));
          } else {
            throw new Error('Project connection could not be saved.');
          }
        } catch (saveError) {
          setSelectedProject(updatedProject);
          setProjects(all => all.map(p => p.id === updatedProject.id ? updatedProject : p));
          setToast('Kobo questions mapped successfully, but the project connection could not be saved yet.');
          console.error('FieldMind project persistence error', saveError);
        }
      }
      if (!selectedProject.id || mapped.length) {
        setToast(mapped.length
          ? 'Mapped ' + mapped.length + ' form questions. QA generation is ready.'
          : 'The form is reachable, but no questions were mapped.');
      }
    } catch (e) {
      setFields([]);
      setKoboCandidates([]);
      const message = e instanceof Error ? e.message : 'Could not inspect that Kobo form.';
      setKoboState({
        checked: true,
        offline: false,
        title: 'Inspection failed',
        questionCount: 0,
        error: message,
      });
      setToast('Kobo inspection: ' + message);
    }
  };

  const createProject = async () => {
    if (!newProject.name.trim() || !newProject.location.trim() || !newProject.topic.trim()) {
      setToast('Add a project name, location and research topic.');
      return;
    }
    try {
      const result = await api.post('/api/projects', {
        name: newProject.name.trim(),
        location: newProject.location.trim(),
        topic: newProject.topic.trim(),
        koboUrl: newProject.koboUrl.trim(),
        formStatus: newProject.koboUrl.trim() ? 'Needs inspection' : 'Not connected',
        offlineReady: false, researchCount: 0, draftCount: 0, approvedCount: 0, updatedAt: 'Just now',
      });
      const project = result.data.project as Project;
      setProjects(p => [project, ...p]);
      setSelectedProject(project);
      setKoboUrl(project.koboUrl || '');
      setFields([]);
      setSources([]);
      setNewProject({ name: '', location: '', topic: '', koboUrl: '' });
      setShowNewProject(false);
      setPage('projects');
      setToast('Project created and saved.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Project could not be saved.');
    }
  };


  const generateDrafts = async () => {
    if (!selectedProject.id) { setToast('Create or select a project first.'); return; }
    if (!koboState.checked || !fields.length) { setToast('Inspect the Kobo form first. Generation is blocked without mapped questions.'); return; }
    setIsGenerating(true);
    try {
      const result = await api.post('/api/brain', {
        project: selectedProject,
        sources,
        fields,
        count: draftCount,
        ageMix,
        majority,
      });
      const incoming = Array.isArray(result.data?.drafts)
        ? result.data.drafts
        : [];
      setDrafts(d => [...incoming, ...d]);
      setProjects(all => all.map(p => p.id === selectedProject.id ? { ...p, draftCount: (p.draftCount || 0) + incoming.length } : p));
      setSelectedProject(p => ({ ...p, draftCount: (p.draftCount || 0) + incoming.length }));
      setPage('review');
      setToast(incoming.length + ' synthetic QA fixtures prepared, validated and sent to review.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'AI generation failed. Try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  const updateDraft = async (updated: Draft, successMessage?: string) => {
    try {
      await api.put('/api/drafts/' + updated.id, updated);
      setDrafts(all => all.map(d => d.id === updated.id ? updated : d));
      if (successMessage) setToast(successMessage);
      return true;
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save draft changes.');
      return false;
    }
  };

  const approveField = async (draftId: string, fieldName: string) => {
    const target = drafts.find(d => d.id === draftId);
    if (!target) return;
    await updateDraft({ ...target, fields: target.fields.map(f => f.name === fieldName ? { ...f, status: 'approved' as const } : f) });
  };

  const rejectField = async (draftId: string, fieldName: string) => {
    const target = drafts.find(d => d.id === draftId);
    if (!target) return;
    await updateDraft({ ...target, status: 'review' as const, fields: target.fields.map(f => f.name === fieldName ? { ...f, status: 'rejected' as const } : f) });
  };

  const deleteDraft = async (draftId: string) => {
    try {
      await api.delete('/api/drafts/' + draftId);
      setDrafts(all => all.filter(d => d.id !== draftId));
      setProjects(all => all.map(p => p.id === selectedProject.id ? { ...p, draftCount: Math.max(0, (p.draftCount || 0) - 1) } : p));
      setSelectedProject(p => ({ ...p, draftCount: Math.max(0, (p.draftCount || 0) - 1) }));
      setToast('Synthetic record deleted.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not delete the record.');
    }
  };

  const editDraft = (draft: Draft) => {
    setEditingDraft(draft);
    setEditValues(Object.fromEntries(draft.fields.map(f => [f.name, f.value])));
  };

  const saveEditedDraft = async () => {
    if (!editingDraft) return;
    const updated = {
      ...editingDraft,
      status: 'review' as const,
      fields: editingDraft.fields.map(f => ({
        ...f,
        value: editValues[f.name] === undefined ? f.value : String(editValues[f.name]),
        status: 'review' as const,
      })),
    };
    const saved = await updateDraft(updated, 'Changes saved. The record returned to review.');
    if (!saved) return;
    setEditingDraft(null);
    setEditValues({});
  };

  const selectProject = async (project: Project) => {
    setSelectedProject(project);
    setKoboUrl(project.koboUrl || '');
    setFields([]);
    setKoboState({ checked: false, offline: false, title: 'Not inspected', questionCount: 0, error: '' });
    setKoboCandidates([]);
    setKoboCandidateUid('');
    try {
      const result = await api.get('/api/sources?projectId=' + encodeURIComponent(project.id));
      setSources(Array.isArray(result.data?.sources) ? result.data.sources : []);
    } catch (e) {
      // Keep the current cached library instead of blanking the workspace.
      setToast(e instanceof Error ? e.message : 'Could not load the research library. Showing cached workspace.');
    }
  };

  const addSource = () => {
    if (!selectedProject.id) { setToast('Create or select a project first.'); return; }
    setNewSource({ title: '', facility: selectedProject.location || '', year: String(new Date().getFullYear()), type: 'Literature', finding: '' });
    setShowSourceModal(true);
  };

  const saveSource = async () => {
    if (!selectedProject.id || !newSource.title.trim() || !newSource.finding.trim()) {
      setToast('Add a source title and documented finding.');
      return;
    }
    try {
      const result = await api.post('/api/sources', {
        projectId: selectedProject.id,
        title: newSource.title.trim(),
        facility: newSource.facility.trim(),
        year: Number(newSource.year) || new Date().getFullYear(),
        type: newSource.type.trim() || 'Literature',
        finding: newSource.finding.trim(),
      });
      setSources(all => [result.data.source, ...all]);
      setProjects(all => all.map(p => p.id === selectedProject.id ? { ...p, researchCount: (p.researchCount || 0) + 1 } : p));
      setSelectedProject(p => ({ ...p, researchCount: (p.researchCount || 0) + 1 }));
      setShowSourceModal(false);
      setToast('Evidence source saved.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Source could not be saved.');
    }
  };

  const deleteSource = async (sourceId: string) => {
    try {
      await api.delete('/api/sources/' + sourceId);
      setSources(all => all.filter(s => s.id !== sourceId));
      setProjects(all => all.map(p => p.id === selectedProject.id ? { ...p, researchCount: Math.max(0, (p.researchCount || 0) - 1) } : p));
      setSelectedProject(p => ({ ...p, researchCount: Math.max(0, (p.researchCount || 0) - 1) }));
      setToast('Source removed.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Source could not be removed.');
    }
  };

  const confirmAll = async () => {
    if (hasRejectedFields) { setToast('Resolve every rejected field before final confirmation.'); return; }
    if (!projectDrafts.length) { setToast('There are no records to confirm.'); return; }
    if (fields.length && projectDrafts.some(d => d.fields.length !== fields.length)) { setToast('Confirmation blocked: a record is missing mapped questions.'); return; }
    try {
      const result = await api.post('/api/drafts/confirm-all', { projectId: selectedProject.id });
      setDrafts(all => all.map(d => d.projectId === selectedProject.id ? { ...d, status: 'confirmed', fields: d.fields.map(f => ({ ...f, status: 'approved' as const })) } : d));
      setToast(result.data?.message || 'Everything is confirmed.');
    } catch (e) { setToast(e instanceof Error ? e.message : 'Confirmation failed.'); }
  };

  const exportPackage = async () => {
    if (!confirmed) { setToast('Export is locked until every record is confirmed.'); return; }
    try {
      const result = await api.post('/api/drafts/export', { projectId: selectedProject.id });
      const blob = new Blob([result.data.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = result.data.filename || 'fieldmind-reviewed-synthetic-qa.csv';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setToast('Reviewed synthetic QA CSV downloaded.');
    } catch (e) { setToast(e instanceof Error ? e.message : 'Export failed.'); }
  };

  const deployPackage = async () => {
    if (!confirmed) { setToast('Package preparation is locked until every record is confirmed.'); return; }
    try {
      const result = await api.post('/api/drafts/deploy', { projectId: selectedProject.id });
      setDrafts(all => all.map(d => d.projectId === selectedProject.id ? { ...d, status: 'deployed' } : d));
      setToast(result.data?.message || 'Controlled QA package prepared.');
    } catch (e) { setToast(e instanceof Error ? e.message : 'Package preparation failed.'); }
  };

  const resetWorkspace = async () => {
    if (!authUser?.isAdmin) return;
    if (!window.confirm('Clear every existing FieldMind research project, source and draft? This cannot be undone.')) return;
    try {
      await api.post('/api/admin/reset-workspace');
      setProjects([]);
      setSources([]);
      setDrafts([]);
      setSelectedProject(emptyProject);
      setFields([]);
      setKoboUrl('');
      setKoboState({ checked: false, offline: false, title: 'Not inspected', questionCount: 0, error: '' });
      try { window.localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {}
      setToast('Workspace cleared. FieldMind is ready for the first real research project.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not clear the workspace.');
    }
  };

  const logout = async () => {
    try { await api.post('/api/auth/logout'); } catch {}
    try {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      window.localStorage.removeItem(KOBO_TOKEN_STORAGE_KEY);
    } catch {}
    setProjects([]);
    setSources([]);
    setDrafts([]);
    setSelectedProject(emptyProject);
    setFields([]);
    setKoboUrl('');
    setKoboToken('');
    setAuthUser(null);
    setAuthStatus('guest');
    setPage('overview');
    setToast('');
  };

  const navTo = (key: string) => {
    setPage(key);
    setMobileOpen(false);
  };

  if (authStatus === 'checking') {
    return <div className="auth-loading"><div className="auth-loading-mark"><Sparkles size={20}/></div><strong>FieldMind</strong><span>Preparing your research workspace…</span></div>;
  }

  if (authStatus === 'guest') {
    return <LandingPage onAuthenticated={(user) => { setAuthUser(user); setAuthStatus('authenticated'); }} />;
  }

  return (
    <div className="shell">
      <aside className={'sidebar ' + (mobileOpen ? 'open' : '')}>
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>FieldMind</strong>
            <span>Research AI</span>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {nav.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={page === item.key ? 'nav-item active' : 'nav-item'}
                onClick={() => navTo(item.key)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.key === 'review' && pending > 0 ? <b>{pending}</b> : null}
              </button>
            );
          })}
        </nav>
        <div className="side-card">
          <div className="side-card-icon">
            <ShieldCheck size={17} />
          </div>
          <strong>Human review is on</strong>
          <p>
            AI drafts cannot become approved research records automatically.
          </p>
        </div>
        <div className="sidebar-foot">
          <span className="status-dot" /> {backendState === 'ready' ? 'System operational' : backendState === 'checking' ? 'Connecting…' : 'Backend needs attention'}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu size={21} />
          </button>
          <div>
            <div className="eyebrow">RESEARCH WORKSPACE</div>
            <h1>
              {page === 'overview'
                ? 'Research command centre'
                : nav.find(n => n.key === page)?.label}
            </h1>
          </div>
          <div className="top-actions">
            <button className="icon-btn" onClick={() => window.location.reload()} aria-label="Refresh workspace" title="Refresh workspace">
              <RefreshCw size={17} />
            </button>
            <div className="user-menu">
              {authUser?.isAdmin && <button className="admin-clear" onClick={resetWorkspace} title="Clear all existing research">Reset old workspace</button>}
              <div className="user-copy"><strong>{authUser?.isAdmin ? 'ADMIN' : 'RESEARCHER'}</strong><span>{authUser?.email}</span></div>
              <div className="avatar">{authUser?.isAdmin ? 'VM' : String(authUser?.email || 'FM').slice(0,2).toUpperCase()}</div>
              <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={16}/></button>
            </div>
          </div>
        </header>
        {backendState !== 'ready' && <div className={'system-banner ' + backendState}><ShieldCheck size={15}/><span>{backendState === 'checking' ? 'Connecting to the research backend…' : 'The backend is unavailable or incompletely configured. Actions are disabled until the connection is restored.'}</span></div>}

        {page === 'overview' && (
          <section className="content">
            <div className="hero">
              <div className="hero-copy">
                <div className="pill">
                  <span className="pulse" /> AI-assisted field research
                </div>
                <h2>
                  Turn local research context into{' '}
                  <em>reviewable field drafts.</em>
                </h2>
                <p>
                  Connect a Kobo form, load evidence from the study area, then
                  generate structured synthetic records for a trained
                  community-health workflow.
                </p>
                <div className="hero-actions">
                  <button
                    className="primary"
                    disabled={backendState !== 'ready'}
                    onClick={() => setPage('projects')}
                  >
                    <Plus size={17} /> New project
                  </button>
                  <button
                    className="secondary"
                    disabled={backendState !== 'ready'}
                    onClick={() => setPage('review')}
                  >
                    Open review queue <ArrowRight size={16} />
                  </button>
                </div>
              </div>
              <div className="hero-visual">
                <div className="orb orb-one" />
                <div className="orb orb-two" />
                <div className="field-illustration" aria-label="Illustrated research workflow">
                  <div className="map-grid" />
                  <div className="route-line route-a" />
                  <div className="route-line route-b" />
                  <div className="pin pin-a"><span /></div>
                  <div className="pin pin-b"><span /></div>
                  <div className="researcher">
                    <div className="researcher-head" />
                    <div className="researcher-body" />
                    <div className="researcher-arm" />
                  </div>
                  <div className="phone-card">
                    <div className="phone-speaker" />
                    <div className="phone-screen">
                      <span className="screen-label">FIELD CHECK</span>
                      <strong>{fields.length || '—'}</strong>
                      <small>questions mapped</small>
                      <i><b /></i>
                    </div>
                  </div>
                </div>
                <div className="research-card">
                  <div className="mini-top">
                    <span>
                      <FlaskConical size={14} /> {selectedProject.id ? selectedProject.name.toUpperCase() : 'YOUR PROJECT'}
                    </span>
                    <span className="live-chip">WORKSPACE</span>
                  </div>
                  <div className="signal-row">
                    <div>
                      <small>Evidence coverage</small>
                      <strong>{projects.length ? Math.round(Math.min(100, (sources.length / Math.max(1, 6)) * 100)) : 0}%</strong>
                    </div>
                    <div className="ring">
                      <span>AI</span>
                    </div>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${projects.length ? Math.round(Math.min(100, (sources.length / Math.max(1, 6)) * 100)) : 0}%` }} />
                  </div>
                  <div className="mini-grid">
                    <span><Database size={14} /> {sources.length} sources</span>
                    <span><ClipboardCheck size={14} /> {projectDrafts.length} drafts</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="stats">
              <Stat
                label="Active projects"
                value={projects.length}
                icon={Layers3}
              />
              <Stat
                label="Evidence sources"
                value={sources.length}
                icon={BookOpen}
              />
              <Stat
                label="Pending review"
                value={pending}
                icon={ClipboardCheck}
              />
              <Stat
                label="Approved records"
                value={approved}
                icon={FileCheck2}
              />
            </div>

            <div className="section-head">
              <div>
                <h3>Current project</h3>
                <p>Everything needed to prepare the next research run.</p>
              </div>
              <button className="text-btn" onClick={() => setPage('projects')}>
                Manage projects <ChevronRight size={15} />
              </button>
            </div>
            <div className="project-panel">
              <div className="project-main">
                <div className="project-icon">
                  <Activity size={21} />
                </div>
                <div>
                  <h3>{selectedProject.name}</h3>
                  <p>{selectedProject.location}</p>
                  <div className="tags">
                    <span>{selectedProject.topic}</span>
                    <span className="green-tag">
                      <Check size={12} /> {selectedProject.formStatus}
                    </span>
                  </div>
                </div>
              </div>
              <div className="project-meta">
                <div>
                  <small>Kobo mode</small>
                  <strong>
                    {selectedProject.offlineReady
                      ? 'Online + offline'
                      : 'Needs check'}
                  </strong>
                </div>
                <div>
                  <small>Research library</small>
                  <strong>{sources.length} sources</strong>
                </div>
                <button
                  className="round-btn"
                  onClick={() => setPage('projects')}
                >
                  <ArrowRight size={17} />
                </button>
              </div>
            </div>

            <div className="two-col">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Kobo connection</h3>
                    <p>Verify the form before an AI run.</p>
                  </div>
                  <Link2 size={18} />
                </div>
                <div className="url-row">
                  <input
                    value={koboUrl}
                    onChange={e => setKoboUrl(e.target.value)}
                    placeholder="https://kf.kobotoolbox.org/#/forms/.../summary or https://ee.kobotoolbox.org/x/..."
                  />
                  <button onClick={checkKobo} disabled={!koboUrl.trim()}>
                    <RefreshCw size={15} /> Check
                  </button>
                </div>
                <p className="field-help">Paste one Kobo link. FieldMind detects the server and Asset UID automatically, then retrieves the deployed XForm.</p>
                {koboCandidates.length > 0 && (
                  <div className="kobo-candidates">
                    <label className="field-label">Choose the Kobo project</label>
                    <select
                      value={koboCandidateUid}
                      onChange={e => setKoboCandidateUid(e.target.value)}
                    >
                      <option value="">Select the matching project…</option>
                      {koboCandidates.map(candidate => (
                        <option key={candidate.uid} value={candidate.uid}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                    <p className="field-help">FieldMind found these surveys through your Kobo account. Select the one behind this /x/ link and tap Check again.</p>
                  </div>
                )}
                <details className="kobo-advanced" open={Boolean(koboToken)}>
                  <summary>Advanced: private Kobo form / API key</summary>
                  <label className="field-label">Kobo API key <span>used for this inspection · kept only for this browser tab</span></label>
                  <div className="secret-row">
                    <input
                      type={showKoboToken ? 'text' : 'password'}
                      value={koboToken}
                      onChange={e => {
                        const value = e.target.value;
                        setKoboToken(value);
                        try {
                          writeKoboTokenStorage(value);
                        } catch {}
                      }}
                      placeholder="Paste your current Kobo API key"
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="secret-toggle"
                      onClick={() => setShowKoboToken(value => !value)}
                      aria-label={showKoboToken ? "Hide Kobo API key" : "Show Kobo API key"}
                      title={showKoboToken ? "Hide API key" : "Show API key"}
                    >
                      {showKoboToken ? <EyeOff size={15} /> : <Eye size={15} />}
                      <span>{showKoboToken ? "Hide" : "Show"}</span>
                    </button>
                  </div>
                  <p className="field-help">The key is saved only in this browser so refreshes and new tabs keep the test-account connection. It is not stored in the project records and is sent only to FieldMind’s Kobo inspection endpoint.</p>
                </details>
                <div className="connection-result">
                  <span
                    className={koboState.offline ? 'check-icon' : 'warn-icon'}
                  >
                    {koboState.offline ? (
                      <Wifi size={15} />
                    ) : (
                      <WifiOff size={15} />
                    )}
                  </span>
                  <div>
                    <strong>{koboState.title}</strong>
                    <small>
                      {koboState.offline
                        ? 'Offline-capable collection detected'
                        : 'Online connection available; verify offline mode'}
                    </small>
                  </div>
                  <span
                    className={
                      koboState.offline ? 'badge green' : 'badge amber'
                    }
                  >
                    {koboState.offline ? 'READY' : 'CHECK'}
                  </span>
                </div>
              </div>
              <div className="panel ai-panel">
                <div className="panel-head">
                  <div>
                    <h3>AI compiler</h3>
                    <p>
                      Compile the mapped Kobo questionnaire into reviewable
                      synthetic QA fixtures using the project's evidence context.
                    </p>
                  </div>
                  <Zap size={18} />
                </div>
                {fields.length > 0 && (
                  <div className="field-map" style={{ marginBottom: 16 }}>
                    <div className="field-map-head">
                      <span>Compiled Kobo questionnaire</span>
                      <span>{fields.length} questions</span>
                    </div>
                    <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                      {fields.map((field, index) => (
                        <div className="field-item" key={field.name}>
                          <span>{index + 1}. {field.label}</span>
                          <code>{field.name}</code>
                          <small>{field.type}{field.required ? ' · required' : ''}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="count-row">
                  <label>QA fixtures</label>
                  <div className="stepper">
                    <button
                      onClick={() => setDraftCount(Math.max(1, draftCount - 1))}
                    >
                      −
                    </button>
                    <strong>{draftCount}</strong>
                    <button
                      onClick={() =>
                        setDraftCount(Math.min(100, draftCount + 1))
                      }
                    >
                      +
                    </button>
                  </div>
                </div>
                <button
                  className="generate"
                  disabled={isGenerating || !selectedProject.id || !fields.length}
                  onClick={generateDrafts}
                >
                  {isGenerating ? (
                    <RefreshCw className="spin" size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {isGenerating ? 'Compiling…' : 'Compile for review'}{' '}
                  <ArrowRight size={15} />
                </button>
                <div className="ai-note">
                  <ShieldCheck size={14} /> QA mode only: every compiled record is
                  explicitly synthetic, reviewable and never submitted to Kobo.
                </div>
              </div>
            </div>
          </section>
        )}

        {page === 'projects' && (
          <section className="content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">PROJECTS</p>
                <h2>Research projects</h2>
                <p>Keep each study, Kobo form and evidence base together.</p>
              </div>
              <button
                className="primary"
                disabled={backendState !== 'ready'}
                onClick={() => setShowNewProject(true)}
              >
                <Plus size={17} /> New project
              </button>
            </div>
            <div className="project-list">
              {projects.length === 0 ? <div className="empty-state"><Layers3 size={30}/><h3>No research projects yet</h3><p>Create your first project to connect a Kobo form and build its evidence library.</p></div> : projects.map(p => (
                <button
                  key={p.id}
                  className={
                    'project-row ' +
                    (selectedProject.id === p.id ? 'selected' : '')
                  }
                  onClick={() => selectProject(p)}
                >
                  <div className="project-icon">
                    <FlaskConical size={19} />
                  </div>
                  <div className="row-copy">
                    <strong>{p.name}</strong>
                    <span>{p.location}</span>
                  </div>
                  <div className="row-stats">
                    <span>{p.researchCount} sources</span>
                    <span>{p.draftCount} drafts</span>
                    <span className="badge green">{p.formStatus}</span>
                  </div>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
            <div className="builder-grid">
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{selectedProject.name}</h3>
                    <p>{selectedProject.topic}</p>
                  </div>
                  <span className="badge green">ACTIVE</span>
                </div>
                <label className="field-label">Kobo form or project Summary URL</label>
                <div className="url-row">
                  <input
                    value={koboUrl}
                    onChange={e => setKoboUrl(e.target.value)}
                    placeholder="https://kf.kobotoolbox.org/#/forms/.../summary or https://ee.kobotoolbox.org/x/..."
                  />
                  <button onClick={checkKobo} disabled={!koboUrl.trim()}>Inspect</button>
                </div>
                <p className="field-help">Paste one Kobo link. FieldMind detects the server and Asset UID automatically, then retrieves the deployed XForm.</p>
                <details className="kobo-advanced">
                  <summary>Advanced: private Kobo form / API key</summary>
                  <label className="field-label">Kobo API key <span>saved on this browser for the test account</span></label>
                  <input
                    type="password"
                    value={koboToken}
                    onChange={e => {
                      const value = e.target.value;
                      setKoboToken(value);
                      writeKoboTokenStorage(value);
                    }}
                    placeholder="Paste your current Kobo API key"
                    autoComplete="new-password"
                  />
                  <p className="field-help">For this single-user test workspace, the key is saved in this browser so you do not need to paste it after refresh. It is never stored with the project record.</p>
                </details>
                <div className="field-map">
                  <div className="field-map-head">
                    <span>Detected form fields</span>
                    <span>{fields.length} fields</span>
                  </div>
                  {fields.map(f => (
                    <div className="field-item" key={f.name}>
                      <span>{f.label}</span>
                      <code>{f.name}</code>
                      <small>{f.type}</small>
                    </div>
                  ))}
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>AI run settings</h3>
                    <p>Set how many synthetic records you want prepared.</p>
                  </div>
                  <Sparkles size={18} />
                </div>
                <div className="setting">
                  <div>
                    <strong>Community-health reasoning</strong>
                    <span>Context-aware fieldworker perspective</span>
                  </div>
                  <div className="toggle on">
                    <i />
                  </div>
                </div>
                <div className="setting">
                  <div>
                    <strong>Evidence grounding</strong>
                    <span>Use only the research library provided</span>
                  </div>
                  <div className="toggle on">
                    <i />
                  </div>
                </div>
                <div className="setting">
                  <div>
                    <strong>Human confirmation</strong>
                    <span>Required before export</span>
                  </div>
                  <div className="toggle on locked">
                    <i />
                  </div>
                </div>
                <div className="setting">
                  <div>
                    <strong>Age distribution</strong>
                    <span>QA coverage mix for synthetic fixtures</span>
                  </div>
                  <input className="setting-input" value={ageMix} onChange={e => setAgeMix(e.target.value)} />
                </div>
                <div className="setting">
                  <div>
                    <strong>Response tendency</strong>
                    <span>QA scenario preference, not observed participant data</span>
                  </div>
                  <select className="setting-input" value={majority} onChange={e => setMajority(e.target.value)}>
                    <option>No directional tendency</option>
                    <option>Mostly agrees</option>
                    <option>Mostly disagrees</option>
                    <option>Mixed responses</option>
                  </select>
                </div>
                <div className="count-row large">
                  <label>Number of draft records</label>
                  <div className="stepper">
                    <button
                      onClick={() => setDraftCount(Math.max(1, draftCount - 1))}
                    >
                      −
                    </button>
                    <strong>{draftCount}</strong>
                    <button
                      onClick={() =>
                        setDraftCount(Math.min(100, draftCount + 1))
                      }
                    >
                      +
                    </button>
                  </div>
                </div>
                <button
                  className="generate"
                  disabled={isGenerating}
                  onClick={generateDrafts}
                >
                  <Sparkles size={16} />{' '}
                  {isGenerating ? 'Generating…' : 'Run AI preparation'}{' '}
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>
          </section>
        )}

        {page === 'research' && (
          <section className="content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">EVIDENCE</p>
                <h2>Research library</h2>
                <p>
                  Context the AI may use when preparing drafts for{' '}
                  {selectedProject.location}.
                </p>
              </div>
              <button
                className="secondary"
                onClick={addSource}
              >
                <Plus size={16} /> Add source
              </button>
            </div>
            <div className="evidence-banner">
              <ShieldCheck size={19} />
              <div>
                <strong>Grounding rule</strong>
                <p>
                  The model is instructed to distinguish documented evidence
                  from inference. It should not invent a citation, statistic or
                  facility-specific fact.
                </p>
              </div>
            </div>
            <div className="source-list">
              {sources.map(s => (
                <div className="source-card" key={s.id}>
                  <div className="source-type">{s.type}</div>
                  <h3>{s.title}</h3>
                  <div className="source-meta">
                    <span>{s.facility}</span>
                    <span>{s.year}</span>
                  </div>
                  <p>{s.finding}</p>
                  <button className="source-link" onClick={() => window.alert(s.finding)}>
                    View evidence <ArrowRight size={14} />
                  </button><button className="source-link danger" onClick={() => deleteSource(s.id)}>
                    Remove <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {page === 'review' && (
          <section className="content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">QUALITY CONTROL</p>
                <h2>Human review queue</h2>
                <p>
                  Nothing generated by the model becomes an approved record
                  without a reviewer.
                </p>
              </div>
              <div className="review-summary">
                <span>
                  <b>{projectDrafts.length}</b> drafts
                </span>
                <span>
                  <b>{pending}</b> pending
                </span>
              </div>
            </div>
            {projectDrafts.length === 0 ? (
              <div className="empty-state">
                <ClipboardCheck size={30} />
                <h3>No drafts yet</h3>
                <p>
                  Run an AI preparation from Overview or Projects to create
                  synthetic records.
                </p>
                <button className="primary" onClick={() => setPage('overview')}>
                  <Sparkles size={16} /> Start AI preparation
                </button>
              </div>
            ) : (
              <>
              <div className="review-banner"><div><strong>{confirmed ? 'Run confirmed' : 'Review required'}</strong><p>{confirmed ? 'Package preparation is unlocked.' : 'Review, edit or delete records before final confirmation.'}</p></div><button className="primary" disabled={confirmed} onClick={confirmAll}><CheckCircle2 size={16}/> Confirm everything is okay</button></div>
              <div className="review-list">
                {projectDrafts.map((d, i) => (
                  <div className="review-card" key={d.id}>
                    <div className="review-head">
                      <div>
                        <span className="synthetic-badge">
                          <Sparkles size={12} /> SYNTHETIC DRAFT
                        </span>
                        <h3>{d.label}</h3>
                        <p>
                          Generated {i === 0 ? 'just now' : 'in this run'} ·
                          Requires fieldworker confirmation
                        </p>
                      </div>
                      <div className="review-card-actions"><span className="review-number">#{projectDrafts.length - i}</span><button className="icon-small" onClick={() => editDraft(d)}>Edit</button><button className="icon-small danger" onClick={() => deleteDraft(d.id)}>Delete</button></div>
                    </div>
                    <div className="draft-fields">
                      {d.fields.map(f => (
                        <div className="draft-field" key={f.name}>
                          <div className="draft-label">
                            <strong>{f.label}</strong>
                            <code>{f.name}</code>
                          </div>
                          <div className="draft-value">{f.value}</div>
                          <div className="evidence">
                            <span>{f.confidence}% confidence</span>
                            <span>{f.evidence}</span>
                          </div>
                          <div className="field-actions">
                            {f.status === 'approved' ? (
                              <span className="approved">
                                <CheckCircle2 size={15} /> Approved
                              </span>
                            ) : f.status === 'rejected' ? (
                              <span className="rejected">
                                <X size={15} /> Rejected
                              </span>
                            ) : (
                              <>
                                <button
                                  onClick={() => rejectField(d.id, f.name)}
                                  className="reject"
                                >
                                  Reject
                                </button>
                                <button
                                  onClick={() => approveField(d.id, f.name)}
                                  className="approve"
                                >
                                  <Check size={14} /> Confirm
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              </>
            )}
          </section>
        )}

        {page === 'export' && (
          <section className="content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">OUTPUT</p>
                <h2>Export centre</h2>
                <p>
                  Prepare reviewed records for a controlled handoff to your Kobo
                  workflow.
                </p>
              </div>
            </div>
            <div className="export-grid">
              <div className="export-card">
                <div className="export-icon">
                  <FileSpreadsheet size={21} />
                </div>
                <h3>Reviewed CSV</h3>
                <p>
                  Download field/value pairs from records that have completed human confirmation.
                </p>
                <button
                  className="secondary"
                  disabled={!confirmed}
                  onClick={exportPackage}
                >
                  {confirmed ? 'Download reviewed CSV' : 'Locked until confirmation'} <ArrowRight size={15} />
                </button>
              </div>
              <div className="export-card">
                <div className="export-icon">
                  <Link2 size={21} />
                </div>
                <h3>Kobo handoff</h3>
                <p>
                  Open the connected form and let the fieldworker complete the
                  final submission in Kobo.
                </p>
                <button
                  className="secondary"
                  onClick={() => selectedProject.koboUrl ? window.open(selectedProject.koboUrl, '_blank') : setToast('No Kobo form is connected to this project.')}
                >
                  Open Kobo form <ArrowRight size={15} />
                </button>
              </div>
              <div className="export-card">
                <div className="export-icon">
                  <ShieldCheck size={21} />
                </div>
                <h3>Audit trail</h3>
                <p>
                  Every AI field carries its confidence, evidence note and
                  review status before it can be treated as approved.
                </p>
                <div className="audit-count">
                  <strong>{approved}</strong>
                  <span>fully reviewed drafts</span>
                </div>
                <button className="secondary" disabled={!confirmed} onClick={deployPackage}>
                  {confirmed ? 'Prepare controlled QA package' : 'Locked until confirmation'} <ArrowRight size={15} />
                </button>
              </div>
            </div>
            <div className="evidence-banner">
              <Wifi size={18} />
              <div>
                <strong>Offline collection</strong>
                <p>
                  Kobo's web form supports online/offline collection after the
                  form has been cached, with submissions queued until
                  connectivity returns. Your final submission should remain a
                  controlled human action.
                </p>
              </div>
            </div>
          </section>
        )}

        {editingDraft && (
          <div className="modal-backdrop" onClick={() => setEditingDraft(null)}>
            <div className="modal edit-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-head">
                <div>
                  <p className="eyebrow">EDIT FIXTURE</p>
                  <h3>Review synthetic record</h3>
                </div>
                <button onClick={() => setEditingDraft(null)}><X size={18} /></button>
              </div>
              <div className="edit-note"><ShieldCheck size={15} /> This is a synthetic QA fixture. Editing returns every field to review status.</div>
              <div className="edit-fields">
                {editingDraft.fields.map(field => (
                  <label key={field.name}>
                    {field.label}
                    <span className="edit-field-name">{field.name}</span>
                    <textarea value={editValues[field.name] ?? field.value} onChange={e => setEditValues(v => ({ ...v, [field.name]: e.target.value }))} />
                  </label>
                ))}
              </div>
              <button className="primary full" onClick={saveEditedDraft}><Check size={16} /> Save changes</button>
            </div>
          </div>
        )}

        {showSourceModal && (
          <div className="modal-backdrop" onClick={() => setShowSourceModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-head">
                <div>
                  <p className="eyebrow">EVIDENCE LIBRARY</p>
                  <h3>Add research source</h3>
                </div>
                <button onClick={() => setShowSourceModal(false)}><X size={18} /></button>
              </div>
              <label>Source title<input value={newSource.title} onChange={e => setNewSource(v => ({ ...v, title: e.target.value }))} placeholder="Paper, report or official source" /></label>
              <div className="form-two">
                <label>Facility / area<input value={newSource.facility} onChange={e => setNewSource(v => ({ ...v, facility: e.target.value }))} placeholder="Area or facility" /></label>
                <label>Year<input type="number" value={newSource.year} onChange={e => setNewSource(v => ({ ...v, year: e.target.value }))} /></label>
              </div>
              <label>Source type<select value={newSource.type} onChange={e => setNewSource(v => ({ ...v, type: e.target.value }))}><option>Literature</option><option>Official report</option><option>Local evidence</option><option>Guideline</option><option>Other</option></select></label>
              <label>Documented finding<textarea value={newSource.finding} onChange={e => setNewSource(v => ({ ...v, finding: e.target.value }))} placeholder="Record only what the source actually documents." /></label>
              <button className="primary full" onClick={saveSource}><Plus size={16} /> Save source</button>
            </div>
          </div>
        )}

        {showNewProject && (
          <div
            className="modal-backdrop"
            onClick={() => setShowNewProject(false)}
          >
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-head">
                <div>
                  <p className="eyebrow">NEW PROJECT</p>
                  <h3>Create research project</h3>
                </div>
                <button onClick={() => setShowNewProject(false)}>
                  <X size={18} />
                </button>
              </div>
              <label>
                Project name
                <input
                  value={newProject.name}
                  onChange={e =>
                    setNewProject({ ...newProject, name: e.target.value })
                  }
                  placeholder="e.g. Community health study"
                />
              </label>
              <label>
                Study location
                <input
                  value={newProject.location}
                  onChange={e =>
                    setNewProject({ ...newProject, location: e.target.value })
                  }
                  placeholder="Facility, town, county"
                />
              </label>
              <label>
                Research topic
                <textarea
                  value={newProject.topic}
                  onChange={e =>
                    setNewProject({ ...newProject, topic: e.target.value })
                  }
                  placeholder="What is this study investigating?"
                />
              </label>
              <label>
                Kobo form link <span className="optional">optional</span>
                <input
                  value={newProject.koboUrl}
                  onChange={e =>
                    setNewProject({ ...newProject, koboUrl: e.target.value })
                  }
                  placeholder="https://ee.kobotoolbox.org/x/..."
                />
              </label>
              <button className="primary full" disabled={backendState !== 'ready'} onClick={createProject}>
                Create project <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="toast">
            <CheckCircle2 size={16} /> {toast}
          </div>
        )}
      </main>
    </div>
  );
}

function LandingPage({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [showAuth, setShowAuth] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    if (!email.trim() || !password) {
      setMessage('Enter your email and password.');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setMessage('Use a password of at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post('/api/auth/' + mode, {
        email: email.trim().toLowerCase(),
        password,
        name: name.trim(),
      });
      if (result.data?.requiresEmailConfirmation) {
        setMessage(result.data.message || 'Check your email to confirm your account.');
      } else if (result.data?.user) {
        onAuthenticated(result.data.user);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-brand"><div className="brand-mark"><Sparkles size={17}/></div><div><strong>FieldMind</strong><span>Research Intelligence</span></div></div>
        <div className="landing-nav-actions">
          <span className="landing-trust"><ShieldCheck size={14}/> Private research workspaces</span>
          <button className="landing-login" onClick={() => { setMode('signin'); setShowAuth(true); }}>Sign in</button>
          <button className="landing-signup" onClick={() => { setMode('signup'); setShowAuth(true); }}>Create account <ArrowUpRight size={14}/></button>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-kicker"><span/> FIELD RESEARCH, BUILT AROUND THE WORK</div>
            <h1>Research that starts<br/><em>with people.</em></h1>
            <p>FieldMind brings questionnaires, evidence, field context and quality review into one calm research workspace — so teams can prepare better studies without losing the human side of the work.</p>
            <div className="landing-actions">
              <button className="landing-primary" onClick={() => { setMode('signup'); setShowAuth(true); }}>Start a research workspace <ArrowRight size={17}/></button>
              <button className="landing-secondary" onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}>See how it works <ChevronRight size={16}/></button>
            </div>
            <div className="landing-proof"><div><ShieldCheck size={16}/><span>Human confirmation built in</span></div><div><Database size={16}/><span>Evidence stays with each study</span></div></div>
          </div>
          <div className="landing-collage">
            <div className="image-main"><img src="https://images.unsplash.com/photo-1540479859555-17af45c78602?auto=format&fit=crop&w=1200&q=85" alt="Children learning together"/></div>
            <div className="image-small image-one"><img src="https://images.unsplash.com/photo-1740741705681-2ac01b194a3f?auto=format&fit=crop&w=700&q=85" alt="Smiling child outdoors"/></div>
            <div className="image-small image-two"><img src="https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=700&q=85" alt="Childhood joy"/></div>
            <div className="collage-note"><Sparkles size={15}/><strong>Curiosity → evidence → action</strong><span>Research is more than a dataset.</span></div>
          </div>
        </section>

        <section className="landing-story" id="how-it-works">
          <div className="story-intro"><span className="landing-kicker"><span/> THE FIELD MINDSET</span><h2>Good research should feel <em>alive.</em></h2><p>Behind every questionnaire is a person, a place and a question worth answering. FieldMind is designed to keep those three visible.</p></div>
          <div className="story-grid">
            <article><div className="story-number">01</div><h3>Build around the study</h3><p>Each account gets its own private research projects, Kobo connection and evidence library. Your work stays separated from everyone else's.</p></article>
            <article><div className="story-number">02</div><h3>Ground the preparation</h3><p>Bring documented literature and local evidence into the workspace. The system keeps evidence as context rather than pretending inference is fact.</p></article>
            <article><div className="story-number">03</div><h3>Keep humans in the loop</h3><p>Generated QA fixtures remain clearly synthetic and require review before export. FieldMind helps test a workflow; it does not turn fiction into participant data.</p></article>
          </div>
        </section>

        <section className="landing-photo-strip">
          <div className="photo-card"><img src="https://images.unsplash.com/photo-1540479859555-17af45c78602?auto=format&fit=crop&w=1000&q=85" alt="Children learning"/><span>Learning</span></div>
          <div className="photo-card tall"><img src="https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1000&q=85" alt="Child exploring"/><span>Curiosity</span></div>
          <div className="photo-card"><img src="https://images.unsplash.com/photo-1740741705681-2ac01b194a3f?auto=format&fit=crop&w=1000&q=85" alt="Smiling child"/><span>Hope</span></div>
          <div className="photo-quote"><span>FIELD NOTES</span><strong>“The point is not simply to collect answers. It is to understand what they mean.”</strong></div>
        </section>

        <section className="landing-cta">
          <div><span className="landing-kicker"><span/> READY WHEN THE STUDY IS</span><h2>Bring the next question<br/>into the field.</h2></div>
          <button className="landing-primary" onClick={() => { setMode('signup'); setShowAuth(true); }}>Create your account <ArrowRight size={17}/></button>
        </section>
      </main>

      <footer className="landing-footer"><span>© {new Date().getFullYear()} FieldMind Research</span><span>Research workspace · Human review · Evidence grounded</span></footer>

      {showAuth && <div className="auth-overlay" onClick={() => setShowAuth(false)}>
        <div className="auth-card" onClick={e => e.stopPropagation()}>
          <div className="auth-card-top"><div className="auth-mini-mark"><Sparkles size={16}/></div><button onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'Create account' : 'Sign in'}</button></div>
          <div className="auth-heading"><span className="landing-kicker"><span/> {mode === 'signin' ? 'WELCOME BACK' : 'JOIN FIELDMIND'}</span><h2>{mode === 'signin' ? 'Your research, ready.' : 'Start your private workspace.'}</h2><p>{mode === 'signin' ? 'Sign in to continue to your studies and evidence.' : 'Every account gets an isolated research workspace.'}</p></div>
          <form onSubmit={submit}>
            {mode === 'signup' && <label><UserRound size={15}/> Full name<input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" autoComplete="name"/></label>}
            <label><Mail size={15}/> Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"/></label>
            <label><LockKeyhole size={15}/> Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}/></label>
            {message && <div className="auth-message">{message}</div>}
            <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in to FieldMind' : 'Create my workspace'} <ArrowRight size={16}/></button>
          </form>
          <p className="auth-foot">{mode === 'signin' ? "New here? " : "Already have an account? "}<button onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'Create an account' : 'Sign in instead'}</button></p>
        </div>
      </div>}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Activity;
}) {
  return (
    <div className="stat">
      <div className="stat-icon">
        <Icon size={17} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

export default App;
