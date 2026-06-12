import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import './ProtocolAuditPagePlain.css';

type SectionsCheck = Record<string, string>;

type DiagnosisOrTherapyAssessment = string | { status?: string; details?: string };

type FinalCheck = {
  ok: boolean;
  errors?: string[] | string;
};

type AnalysisResult = {
  dateOfAdmission?: string;
  patientFio?: string;
  doctorFio?: string;
  lifeAnamnesis?: string;
  diagnosisAssessment?: DiagnosisOrTherapyAssessment;
  therapyAssessment?: DiagnosisOrTherapyAssessment;
  recommendations?: string;
  sectionsCheck?: SectionsCheck;
  finalCheck?: FinalCheck;
  extractedText?: string;
  _usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  };
};

type ProtocolListItem = {
  url: string;
  fileName: string;
  status: 'NEW' | 'OK' | 'ERROR';
  analyzedAt?: string;
  doctorFio?: string | null;
  patientFio?: string | null;
};

type DoctorErrorsStat = {
  doctorFio: string;
  withErrors: number;
  total: number;
};

function getErrorRatePercent(withErrors: number, total: number): number {
  if (!total) return 0;
  return Math.round((withErrors / total) * 100);
}

type DoctorProtocolItem = {
  url: string;
  fileName: string;
  status: 'NEW' | 'OK' | 'ERROR';
  analyzedAt?: string;
};

type DoctorProtocolsResponse = {
  doctorFio: string;
  period: 'recent' | 'week' | 'month' | 'all';
  total: number;
  items: DoctorProtocolItem[];
};

type DoctorRatingItem = {
  doctorFio: string;
  withErrors: number;
  total: number;
  errorRate: number;
  okRate: number;
};

type DoctorsRatingResponse = {
  minSamples: number;
  topBest: DoctorRatingItem[];
  topWorst: DoctorRatingItem[];
};

type ErrorsTimelineItem = {
  date: string;
  total: number;
  withErrors: number;
  ok: number;
  errorRate: number;
};

type ErrorsTimelineResponse = {
  period: 'week' | 'month' | 'all';
  items: ErrorsTimelineItem[];
};

type UploadProtocolResponse = {
  url: string;
  analysis: AnalysisResult;
};

type BackgroundQueueState = {
  running: boolean;
  stopRequested: boolean;
  queued: number;
  processed: number;
  failed: number;
  currentUrl?: string | null;
  startedAt?: string | null;
};

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 300000,
});

function normalizeSectionValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function isOkValue(v: unknown): boolean {
  const s = normalizeSectionValue(v).toUpperCase();
  return s === 'ОК' || s === 'OK';
}

function isErrorLikeValue(v: unknown): boolean {
  const s = normalizeSectionValue(v).toLowerCase();
  if (!s) return false;
  return (
    s.includes('ошиб') ||
    s.includes('не заполн') ||
    s.includes('не заполнен') ||
    s.includes('отсут') ||
    s.includes('нет ') ||
    s.includes('не соответствует') ||
    s.includes('некоррект') ||
    s.includes('неверн')
  );
}

function pickChipClass(v: unknown): string {
  if (isOkValue(v)) return 'chip chip--ok';
  if (isErrorLikeValue(v)) return 'chip chip--error';
  if (normalizeSectionValue(v).length) return 'chip chip--warn';
  return 'chip chip--default';
}

function formatAssessment(value: DiagnosisOrTherapyAssessment | undefined) {
  if (!value) return <>—</>;
  if (typeof value === 'string') return <>{value}</>;
  return (
    <div>
      <div className="assessment-title">{value.status || '—'}</div>
      {value.details ? <pre className="assessment-details">{value.details}</pre> : null}
    </div>
  );
}

export default function ProtocolAuditPagePlain() {
  const [protocols, setProtocols] = useState<ProtocolListItem[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'compare' | 'stats'>('compare');
  const [protocolFilter, setProtocolFilter] = useState<'all' | 'checked' | 'new' | 'ok' | 'error'>('all');
  const selectedProtocolRef = useRef<HTMLButtonElement | null>(null);

  const selectedProtocol = useMemo(
    () => (selectedUrl ? protocols.find((p) => p.url === selectedUrl) || null : null),
    [protocols, selectedUrl],
  );

  const filteredProtocols = useMemo(() => {
    switch (protocolFilter) {
      case 'checked':
        return protocols.filter((p) => p.status !== 'NEW');
      case 'new':
        return protocols.filter((p) => p.status === 'NEW');
      case 'ok':
        return protocols.filter((p) => p.status === 'OK');
      case 'error':
        return protocols.filter((p) => p.status === 'ERROR');
      default:
        return protocols;
    }
  }, [protocolFilter, protocols]);

  const protocolCounters = useMemo(() => {
    const total = protocols.length;
    const ok = protocols.filter((p) => p.status === 'OK').length;
    const error = protocols.filter((p) => p.status === 'ERROR').length;
    const fresh = protocols.filter((p) => p.status === 'NEW').length;
    const checked = total - fresh;
    return { total, ok, error, fresh, checked };
  }, [protocols]);

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [originalDownloading, setOriginalDownloading] = useState(false);

  const [doctorStats, setDoctorStats] = useState<DoctorErrorsStat[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [doctorSearch, setDoctorSearch] = useState('');
  const [statsTab, setStatsTab] = useState<'errors' | 'rating' | 'charts'>('errors');
  const [doctorErrorsPeriod, setDoctorErrorsPeriod] = useState<'day' | 'week' | 'month' | 'year' | 'all'>('all');
  const [doctorRating, setDoctorRating] = useState<DoctorsRatingResponse | null>(null);
  const [loadingRating, setLoadingRating] = useState(false);
  const [timelinePeriod, setTimelinePeriod] = useState<'week' | 'month' | 'all'>('month');
  const [timeline, setTimeline] = useState<ErrorsTimelineResponse | null>(null);
  const [loadingTimeline, setLoadingTimeline] = useState(false);

  const [uiError, setUiError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [backgroundQueue, setBackgroundQueue] = useState<BackgroundQueueState | null>(null);
  const [queueActionLoading, setQueueActionLoading] = useState(false);

  const [doctorModalOpen, setDoctorModalOpen] = useState(false);
  const [doctorModalFio, setDoctorModalFio] = useState<string | null>(null);
  const [doctorModalPeriod, setDoctorModalPeriod] = useState<'recent' | 'week' | 'month' | 'all'>('recent');
  const [doctorModalLoading, setDoctorModalLoading] = useState(false);
  const [doctorModalData, setDoctorModalData] = useState<DoctorProtocolsResponse | null>(null);

  const filteredDoctorStats = useMemo(() => {
    const q = doctorSearch.trim().toLowerCase();
    if (!q) return doctorStats;
    return doctorStats.filter((d) => d.doctorFio.toLowerCase().includes(q));
  }, [doctorSearch, doctorStats]);

  const downloadDoctorsErrorsReport = useCallback(
    async (opts: { format: 'csv' | 'pdf' | 'xlsx'; doctorFio?: string }) => {
      setUiError(null);
      try {
        const params = new URLSearchParams();
        params.set('format', opts.format);
        params.set('period', doctorErrorsPeriod);
        if (opts.doctorFio) params.set('doctorFio', opts.doctorFio);

        const res = await fetch(`/api/v1/stats/doctors-errors/export?${params.toString()}`, { method: 'GET' });
        if (!res.ok) throw new Error('Failed to download report');
        const blob = await res.blob();

        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename =
          match?.[1] ||
          `doctors_errors_${opts.doctorFio ? 'one' : 'all'}_${doctorErrorsPeriod}.${opts.format}`;

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e: any) {
        setUiError(e?.message || 'Ошибка скачивания отчёта');
      }
    },
    [doctorErrorsPeriod],
  );

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    setUiError(null);
    try {
      const res = await api.get<DoctorErrorsStat[]>('/stats/doctors-errors');
      setDoctorStats(res.data);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка загрузки статистики');
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const loadDoctorProtocols = useCallback(async (doctorFio: string, period: DoctorProtocolsResponse['period']) => {
    setDoctorModalLoading(true);
    try {
      const res = await api.get<DoctorProtocolsResponse>('/stats/doctor-protocols', {
        params: { doctorFio, period },
      });
      setDoctorModalData(res.data);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка загрузки протоколов врача');
      setDoctorModalData(null);
    } finally {
      setDoctorModalLoading(false);
    }
  }, []);

  const loadDoctorRating = useCallback(async () => {
    setLoadingRating(true);
    try {
      const res = await api.get<DoctorsRatingResponse>('/stats/doctors-rating', {
        params: { top: 10, minSamples: 1 },
      });
      setDoctorRating(res.data);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка загрузки рейтинга врачей');
      setDoctorRating(null);
    } finally {
      setLoadingRating(false);
    }
  }, []);

  const loadTimeline = useCallback(async (period: ErrorsTimelineResponse['period']) => {
    setLoadingTimeline(true);
    try {
      const res = await api.get<ErrorsTimelineResponse>('/stats/errors-timeline', {
        params: { period },
      });
      setTimeline(res.data);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка загрузки графиков');
      setTimeline(null);
    } finally {
      setLoadingTimeline(false);
    }
  }, []);

  const loadBackgroundStatus = useCallback(async () => {
    try {
      const res = await api.get<BackgroundQueueState>('/protocols/background-status');
      setBackgroundQueue(res.data);
    } catch {
      // ignore temporary status errors
    }
  }, []);

  const syncList = useCallback(async () => {
    setLoadingList(true);
    setUiError(null);
    try {
      const res = await api.post<{ files: ProtocolListItem[] }>('/protocols/sync-list');
      setProtocols(res.data.files);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка загрузки списка протоколов');
      setProtocols([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void syncList();
    void loadStats();
    void loadDoctorRating();
    void loadTimeline(timelinePeriod);
    void loadBackgroundStatus();
  }, [syncList, loadStats, loadDoctorRating, loadTimeline, timelinePeriod, loadBackgroundStatus]);

  useEffect(() => {
    if (!backgroundQueue?.running) return;
    const timer = window.setInterval(() => {
      void loadBackgroundStatus();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [backgroundQueue?.running, loadBackgroundStatus]);

  const runAnalyze = useCallback(
    async (url: string) => {
      setLoadingAnalysis(true);
      setUiError(null);
      try {
        const res = await api.post<{ analysis: AnalysisResult }>('/protocols/analyze', { url });
        const a = res.data.analysis;
        setAnalysis(a);

        const status: ProtocolListItem['status'] = a.finalCheck?.ok ? 'OK' : 'ERROR';
        setProtocols((prev) =>
          prev.map((p) => (p.url === url ? { ...p, status, analyzedAt: p.analyzedAt || new Date().toISOString() } : p)),
        );
        void loadStats();
      } catch (e: any) {
        setUiError(e?.response?.data?.detail || 'Ошибка анализа протокола');
      } finally {
        setLoadingAnalysis(false);
      }
    },
    [loadStats],
  );

  const onSelectProtocol = useCallback(
    async (url: string) => {
      setSelectedUrl(url);
      setAnalysis(null);
      setActiveTab('compare');
      await runAnalyze(url);
    },
    [runAnalyze],
  );

  const openDoctorModal = useCallback(
    async (fio: string) => {
      setDoctorModalFio(fio);
      setDoctorModalPeriod('recent');
      setDoctorModalOpen(true);
      await loadDoctorProtocols(fio, 'recent');
    },
    [loadDoctorProtocols],
  );

  const downloadOriginal = useCallback(async () => {
    if (!selectedUrl) return;
    setOriginalDownloading(true);
    setUiError(null);
    try {
      const res = await fetch(
        `/api/v1/protocols/original?url=${encodeURIComponent(selectedUrl)}`,
        { method: 'GET' },
      );
      if (!res.ok) throw new Error('Failed to download');
      const blob = await res.blob();
      const filename =
        selectedProtocol?.fileName || `protocol_${selectedUrl.split('/').pop() || 'pdf'}.pdf`;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      setUiError(e?.message || 'Ошибка скачивания оригинала');
    } finally {
      setOriginalDownloading(false);
    }
  }, [selectedProtocol?.fileName, selectedUrl]);

  const uploadProtocol = useCallback(
    async (file: File) => {
      setUploading(true);
      setUiError(null);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await api.post<UploadProtocolResponse>('/protocols/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        const { url, analysis: a } = res.data;
        setProtocolFilter('all');
        setSelectedUrl(url);
        setAnalysis(a);

        await syncList();
        setActiveTab('compare');
      } catch (e: any) {
        setUiError(e?.response?.data?.detail || 'Ошибка загрузки протокола');
      } finally {
        setUploading(false);
      }
    },
    [syncList],
  );

  const runBackgroundNow = useCallback(async () => {
    setUiError(null);
    setQueueActionLoading(true);
    try {
      await api.post('/protocols/background-run', { limit: null });
      await loadBackgroundStatus();
      await syncList();
      await loadStats();
      await loadDoctorRating();
      await loadTimeline(timelinePeriod);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка запуска фонового анализа');
    } finally {
      setQueueActionLoading(false);
    }
  }, [loadBackgroundStatus, loadDoctorRating, loadStats, loadTimeline, syncList, timelinePeriod]);

  const stopBackgroundNow = useCallback(async () => {
    setUiError(null);
    setQueueActionLoading(true);
    try {
      await api.post('/protocols/background-stop');
      await loadBackgroundStatus();
      await syncList();
      await loadStats();
      await loadDoctorRating();
      await loadTimeline(timelinePeriod);
    } catch (e: any) {
      setUiError(e?.response?.data?.detail || 'Ошибка остановки фонового анализа');
    } finally {
      setQueueActionLoading(false);
    }
  }, [loadBackgroundStatus, loadDoctorRating, loadStats, loadTimeline, syncList, timelinePeriod]);

  const ratingMaxTotal = useMemo(
    () =>
      Math.max(
        1,
        ...(doctorRating?.topBest.map((i) => i.total) || []),
        ...(doctorRating?.topWorst.map((i) => i.total) || []),
      ),
    [doctorRating],
  );

  const timelineMax = useMemo(() => Math.max(1, ...(timeline?.items.map((i) => i.withErrors) || [])), [timeline]);

  useEffect(() => {
    if (!selectedUrl) return;
    // Ждём, пока список отрендерит выбранный элемент (после sync/upload)
    const id = window.setTimeout(() => {
      selectedProtocolRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => window.clearTimeout(id);
  }, [selectedUrl, filteredProtocols.length]);

  return (
    <div className="pa-root">
      <div className="pa-header">
        <div>
          <div className="pa-title">Анализ медицинских протоколов</div>
          <div className="pa-subtitle">Проверка разделов, оценка диагноза/терапии, статистика по врачам с ошибками.</div>
        </div>
        <div className="pa-actions">
          <label className={`btn btn--secondary ${uploading ? 'btn--disabled-like' : ''}`}>
            {uploading ? 'Загрузка...' : 'Загрузить PDF'}
            <input
              type="file"
              accept="application/pdf"
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadProtocol(f);
              }}
            />
          </label>
          <button
            className="btn btn--primary"
            onClick={() => void downloadOriginal()}
            disabled={!selectedUrl || originalDownloading}
            title={!selectedUrl ? 'Сначала выберите протокол' : undefined}
          >
            {originalDownloading ? 'Скачиваю...' : 'Скачать PDF'}
          </button>
          <button className="btn btn--primary" onClick={() => void syncList()} disabled={loadingList}>
            {loadingList ? 'Обновляю...' : 'Обновить список'}
          </button>
          <button className="btn btn--secondary" onClick={() => void runBackgroundNow()} disabled={queueActionLoading}>
            {queueActionLoading ? 'Обработка...' : 'Запустить очередь анализа'}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void stopBackgroundNow()}
            disabled={!backgroundQueue?.running || queueActionLoading}
          >
            Остановить очередь
          </button>
          <button className="btn btn--ghost" onClick={() => void loadStats()} disabled={loadingStats}>
            {loadingStats ? 'Статистика...' : 'Обновить статистику'}
          </button>
        </div>
      </div>

      <div className="pa-muted">
        Очередь анализа: {backgroundQueue?.running ? 'работает' : 'остановлена'}
        {backgroundQueue
          ? ` · в очереди ${backgroundQueue.queued} · обработано ${backgroundQueue.processed} · ошибок ${backgroundQueue.failed}`
          : ''}
      </div>

      {uiError ? <div className="pa-error">{uiError}</div> : null}

      <div className="pa-layout">
        <div className="pa-left">
          <div className="pa-left-title">
            <div className="pa-left-title-row">
              <span>Протоколы</span>
              <span className="pa-left-count">{protocolCounters.total}</span>
            </div>
            <div className="pa-left-counters">
              <button
                type="button"
                className={`chip chip--default pa-filter-chip ${protocolFilter === 'checked' ? 'pa-filter-chip--active' : ''}`}
                onClick={() => setProtocolFilter((v) => (v === 'checked' ? 'all' : 'checked'))}
                title="Показать только проверенные"
              >
                Проверено: {protocolCounters.checked}
              </button>
              <button
                type="button"
                className={`chip chip--default pa-filter-chip ${protocolFilter === 'new' ? 'pa-filter-chip--active' : ''}`}
                onClick={() => setProtocolFilter((v) => (v === 'new' ? 'all' : 'new'))}
                title="Показать только не проверенные"
              >
                Нет: {protocolCounters.fresh}
              </button>
              <button
                type="button"
                className={`chip chip--ok pa-filter-chip ${protocolFilter === 'ok' ? 'pa-filter-chip--active' : ''}`}
                onClick={() => setProtocolFilter((v) => (v === 'ok' ? 'all' : 'ok'))}
                title="Показать только OK"
              >
                OK: {protocolCounters.ok}
              </button>
              <button
                type="button"
                className={`chip chip--error pa-filter-chip ${protocolFilter === 'error' ? 'pa-filter-chip--active' : ''}`}
                onClick={() => setProtocolFilter((v) => (v === 'error' ? 'all' : 'error'))}
                title="Показать только с ошибками"
              >
                Ошибки: {protocolCounters.error}
              </button>
            </div>
          </div>
          <div className="pa-left-list">
            {filteredProtocols.length === 0 ? (
              <div className="pa-muted">{loadingList ? 'Загрузка...' : 'Файлы не найдены'}</div>
            ) : (
              filteredProtocols.map((p) => (
                <button
                  key={p.url}
                  className={`pa-protocol-item ${p.url === selectedUrl ? 'pa-protocol-item--active' : ''}`}
                  onClick={() => void onSelectProtocol(p.url)}
                  type="button"
                  ref={p.url === selectedUrl ? (el) => (selectedProtocolRef.current = el) : undefined}
                >
                  <span className="pa-protocol-main">
                    <span className="pa-protocol-line">
                      <span className="pa-protocol-line-label">Врач:</span>{' '}
                      <span className="pa-protocol-line-value">{p.doctorFio || '—'}</span>
                    </span>
                    <span className="pa-protocol-line">
                      <span className="pa-protocol-line-label">Пациент:</span>{' '}
                      <span className="pa-protocol-line-value">{p.patientFio || '—'}</span>
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className={p.status === 'OK' ? 'chip chip--ok' : p.status === 'ERROR' ? 'chip chip--error' : 'chip chip--default'}
                    title="Клик: сменить статус"
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextStatus =
                        p.status === 'NEW' ? 'OK' : p.status === 'OK' ? 'ERROR' : 'NEW';
                      void (async () => {
                        try {
                          await api.post('/protocols/update-status', {
                            url: p.url,
                            status: nextStatus,
                          });
                          setProtocols((prev) =>
                            prev.map((it) =>
                              it.url === p.url ? { ...it, status: nextStatus } : it,
                            ),
                          );
                          await loadStats();
                        } catch (e: any) {
                          setUiError(e?.response?.data?.detail || 'Не удалось обновить статус протокола');
                        }
                      })();
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      const nextStatus =
                        p.status === 'NEW' ? 'OK' : p.status === 'OK' ? 'ERROR' : 'NEW';
                      void (async () => {
                        try {
                          await api.post('/protocols/update-status', {
                            url: p.url,
                            status: nextStatus,
                          });
                          setProtocols((prev) =>
                            prev.map((it) =>
                              it.url === p.url ? { ...it, status: nextStatus } : it,
                            ),
                          );
                          await loadStats();
                        } catch (err: any) {
                          setUiError(err?.response?.data?.detail || 'Не удалось обновить статус протокола');
                        }
                      })();
                    }}
                  >
                    {p.status}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="pa-right">
          <div className="pa-tabs">
            <button
              type="button"
              className={`pa-tab ${activeTab === 'compare' ? 'pa-tab--active' : ''}`}
              onClick={() => setActiveTab('compare')}
            >
              Сравнение
            </button>
            <button
              type="button"
              className={`pa-tab ${activeTab === 'stats' ? 'pa-tab--active' : ''}`}
              onClick={() => setActiveTab('stats')}
            >
              Статистика
            </button>
          </div>

          {activeTab === 'compare' ? (
            <div className="pa-grid2">
              <div className="pa-panel">
                <div className="pa-panel-title">
                  <span>Анализ</span>
                  {loadingAnalysis ? <span className="pa-inline-loading">Анализ...</span> : null}
                </div>
                {!selectedUrl ? (
                  <div className="pa-panel-body">
                    <div className="pa-muted">Выберите протокол для анализа</div>
                  </div>
                ) : !analysis ? (
                  <div className="pa-panel-body">
                    <div className="pa-muted">Анализируем...</div>
                  </div>
                ) : (
                  <div className="pa-panel-body">
                    <div className="pa-kv">
                      <div className="pa-kv-label">Дата приёма</div>
                      <div className="pa-kv-value">{analysis.dateOfAdmission || '—'}</div>
                    </div>
                    <div className="pa-kv">
                      <div className="pa-kv-label">Пациент</div>
                      <div className="pa-kv-value">{analysis.patientFio || '—'}</div>
                    </div>
                    <div className="pa-kv">
                      <div className="pa-kv-label">Врач</div>
                      <div className="pa-kv-value">{analysis.doctorFio || '—'}</div>
                    </div>
                    <div className="pa-kv">
                      <div className="pa-kv-label">Итог</div>
                      <div className="pa-kv-value">
                        <span className={analysis.finalCheck?.ok ? 'chip chip--ok' : 'chip chip--error'}>
                          {analysis.finalCheck?.ok ? 'ОК' : 'Есть ошибки'}
                        </span>
                      </div>
                    </div>
                    <div className="pa-kv">
                      <div className="pa-kv-label">Токены (OpenAI)</div>
                      <div className="pa-kv-value">
                        {analysis._usage?.total_tokens != null ? (
                          <>
                            всего {analysis._usage.total_tokens}
                            {analysis._usage.prompt_tokens != null ? ` · prompt ${analysis._usage.prompt_tokens}` : ''}
                            {analysis._usage.completion_tokens != null
                              ? ` · completion ${analysis._usage.completion_tokens}`
                              : ''}
                          </>
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>

                    <div className="pa-divider" />

                    <div className="pa-section-title">Проверка разделов</div>
                    <div className="pa-chips">
                      {analysis.sectionsCheck && Object.keys(analysis.sectionsCheck).length > 0 ? (
                        Object.entries(analysis.sectionsCheck).map(([k, v]) => (
                          <span key={k} className={pickChipClass(v)}>
                            {k}: {v || '—'}
                          </span>
                        ))
                      ) : (
                        <div className="pa-muted">Нет данных по разделам</div>
                      )}
                    </div>

                    <div className="pa-divider" />

                    <div className="pa-section-title">Анамнез жизни</div>
                    <pre className="pa-pre">{analysis.lifeAnamnesis || '—'}</pre>

                    <div className="pa-divider" />

                    <div className="pa-section-title">Оценка диагноза</div>
                    <div className="pa-assessment">{formatAssessment(analysis.diagnosisAssessment)}</div>

                    <div className="pa-divider" />

                    <div className="pa-section-title">Оценка терапии</div>
                    <div className="pa-assessment">{formatAssessment(analysis.therapyAssessment)}</div>

                    <div className="pa-divider" />

                    <div className="pa-section-title">Рекомендации</div>
                    <pre className="pa-pre">{analysis.recommendations || '—'}</pre>
                  </div>
                )}
              </div>

              <div className="pa-panel">
                <div className="pa-panel-title">
                  <span>Оригинал (текст из PDF)</span>
                </div>
                <div className="pa-panel-body">
                  <div className="pa-muted">{selectedProtocol ? selectedProtocol.fileName : 'Файл не выбран'}</div>
                  <div className="pa-divider" />
                  <pre className="pa-pre pa-pre--mono">{analysis?.extractedText || '—'}</pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="pa-grid1">
              <div className="pa-panel">
                <div className="pa-panel-title">
                  <span>Статистика</span>
                  {(loadingStats || loadingRating || loadingTimeline) ? <span className="pa-inline-loading">Загрузка...</span> : null}
                </div>
                <div className="pa-panel-body">
                  <div className="pa-tabs pa-tabs--inner">
                    <button type="button" className={`pa-tab ${statsTab === 'errors' ? 'pa-tab--active' : ''}`} onClick={() => setStatsTab('errors')}>
                      Ошибки по врачам
                    </button>
                    <button type="button" className={`pa-tab ${statsTab === 'rating' ? 'pa-tab--active' : ''}`} onClick={() => setStatsTab('rating')}>
                      Лучшие / Худшие
                    </button>
                    <button type="button" className={`pa-tab ${statsTab === 'charts' ? 'pa-tab--active' : ''}`} onClick={() => setStatsTab('charts')}>
                      Графики
                    </button>
                  </div>

                  {statsTab === 'errors' ? (
                    <>
                      <div className="pa-search-row">
                        <input
                          className="pa-input"
                          type="text"
                          placeholder="Поиск врача по ФИО..."
                          value={doctorSearch}
                          onChange={(e) => setDoctorSearch(e.target.value)}
                        />
                        <select
                          className="pa-input"
                          style={{ width: 200 }}
                          value={doctorErrorsPeriod}
                          onChange={(e) => setDoctorErrorsPeriod(e.target.value as any)}
                          title="Период для экспорта"
                        >
                          <option value="day">День</option>
                          <option value="week">Неделя</option>
                          <option value="month">Месяц</option>
                          <option value="year">Год</option>
                          <option value="all">Всё время</option>
                        </select>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          onClick={() => void downloadDoctorsErrorsReport({ format: 'csv' })}
                          title="Скачать CSV по всем врачам"
                        >
                          CSV (все)
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          onClick={() => void downloadDoctorsErrorsReport({ format: 'pdf' })}
                          title="Скачать PDF по всем врачам"
                        >
                          PDF (все)
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          onClick={() => void downloadDoctorsErrorsReport({ format: 'xlsx' })}
                          title="Скачать Excel по всем врачам"
                        >
                          Excel (все)
                        </button>
                        <span className="pa-muted">Найдено: {filteredDoctorStats.length}</span>
                      </div>
                    {filteredDoctorStats.length === 0 ? (
                      <div className="pa-muted">Пока нет данных</div>
                    ) : (
                      <table className="pa-table">
                        <thead>
                          <tr>
                            <th>Врач</th>
                            <th style={{ textAlign: 'right' }}>Ошибок</th>
                            <th style={{ textAlign: 'right' }}>Всего</th>
                            <th style={{ textAlign: 'right' }}>% ошибок</th>
                            <th style={{ textAlign: 'right' }}>Экспорт</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredDoctorStats.map((s) => (
                            <tr key={s.doctorFio}>
                              <td className="pa-table-td-ellipsis">
                                <button type="button" className="pa-link" onClick={() => void openDoctorModal(s.doctorFio)}>
                                  {s.doctorFio}
                                </button>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="chip chip--error">{s.withErrors}</span>
                              </td>
                              <td style={{ textAlign: 'right' }}>{s.total}</td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="chip chip--warn">
                                  {getErrorRatePercent(s.withErrors, s.total)}%
                                </span>
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => void downloadDoctorsErrorsReport({ format: 'csv', doctorFio: s.doctorFio })}
                                >
                                  CSV
                                </button>
                                {' '}
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => void downloadDoctorsErrorsReport({ format: 'pdf', doctorFio: s.doctorFio })}
                                >
                                  PDF
                                </button>
                                  {' '}
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    onClick={() => void downloadDoctorsErrorsReport({ format: 'xlsx', doctorFio: s.doctorFio })}
                                  >
                                    Excel
                                  </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    </>
                  ) : null}

                  {statsTab === 'rating' ? (
                    <div className="pa-rating-grid">
                      <div>
                        <div className="pa-section-title">Топ лучших (OK ≥ 70%)</div>
                        {doctorRating?.topBest.length ? doctorRating.topBest.map((r, idx) => (
                          <div
                            className={`pa-rating-item ${idx < 3 ? 'pa-rating-item--top3 pa-rating-item--best' : ''}`}
                            key={`best-${r.doctorFio}`}
                          >
                            <div className="pa-rating-head">
                              <button type="button" className="pa-link" onClick={() => void openDoctorModal(r.doctorFio)}>
                                {r.doctorFio}
                              </button>
                              <span className={`pa-rank ${idx === 0 ? 'pa-rank--1' : idx === 1 ? 'pa-rank--2' : idx === 2 ? 'pa-rank--3' : ''}`}>
                                #{idx + 1}
                              </span>
                            </div>
                            <div className="pa-rating-kpis">
                              <span className="chip chip--ok">OK {Math.round(r.okRate * 100)}%</span>
                              <span className="chip chip--default">Ошибки {r.withErrors}/{r.total}</span>
                            </div>
                            <div className="pa-bar-track">
                              <div className="pa-bar-fill pa-bar-fill--ok" style={{ width: `${Math.max(4, r.okRate * 100)}%` }} />
                            </div>
                            <div className="pa-muted">OK: {r.total - r.withErrors} / Всего: {r.total}</div>
                          </div>
                        )) : <div className="pa-muted">Нет данных</div>}
                      </div>
                      <div>
                        <div className="pa-section-title">Топ худших (OK &lt; 70%)</div>
                        {doctorRating?.topWorst.length ? doctorRating.topWorst.map((r, idx) => (
                          <div
                            className={`pa-rating-item ${idx < 3 ? 'pa-rating-item--top3 pa-rating-item--worst' : ''}`}
                            key={`worst-${r.doctorFio}`}
                          >
                            <div className="pa-rating-head">
                              <button type="button" className="pa-link" onClick={() => void openDoctorModal(r.doctorFio)}>
                                {r.doctorFio}
                              </button>
                              <span className={`pa-rank ${idx === 0 ? 'pa-rank--1' : idx === 1 ? 'pa-rank--2' : idx === 2 ? 'pa-rank--3' : ''}`}>
                                #{idx + 1}
                              </span>
                            </div>
                            <div className="pa-rating-kpis">
                              <span className="chip chip--error">OK {Math.round(r.okRate * 100)}%</span>
                              <span className="chip chip--default">Ошибки {r.withErrors}/{r.total}</span>
                            </div>
                            <div className="pa-bar-track">
                              <div className="pa-bar-fill pa-bar-fill--error" style={{ width: `${Math.max(4, r.okRate * 100)}%` }} />
                            </div>
                            <div className="pa-muted">OK: {r.total - r.withErrors} / Всего: {r.total}</div>
                          </div>
                        )) : <div className="pa-muted">Нет данных</div>}
                      </div>
                    </div>
                  ) : null}

                  {statsTab === 'charts' ? (
                    <div>
                      <div className="pa-tabs pa-tabs--inner">
                        <button type="button" className={`pa-tab ${timelinePeriod === 'week' ? 'pa-tab--active' : ''}`} onClick={() => setTimelinePeriod('week')}>
                          Неделя
                        </button>
                        <button type="button" className={`pa-tab ${timelinePeriod === 'month' ? 'pa-tab--active' : ''}`} onClick={() => setTimelinePeriod('month')}>
                          Месяц
                        </button>
                        <button type="button" className={`pa-tab ${timelinePeriod === 'all' ? 'pa-tab--active' : ''}`} onClick={() => setTimelinePeriod('all')}>
                          Все
                        </button>
                      </div>
                      <div className="pa-section-title">Ошибки по датам</div>
                      {!timeline?.items.length ? (
                        <div className="pa-muted">Нет данных для графика</div>
                      ) : (
                        <div className="pa-chart-list">
                          {timeline.items.map((it) => (
                            <div className="pa-chart-row" key={it.date}>
                              <div className="pa-chart-date">{it.date}</div>
                              <div className="pa-bar-track">
                                <div
                                  className="pa-bar-fill pa-bar-fill--error"
                                  style={{ width: `${Math.max(3, (it.withErrors / timelineMax) * 100)}%` }}
                                />
                              </div>
                              <div className="pa-chart-meta">
                                ошибок {it.withErrors} / всего {it.total} ({Math.round(it.errorRate * 100)}%)
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {doctorModalOpen ? (
        <div className="pa-modal-overlay" role="dialog" aria-modal="true">
          <div className="pa-modal">
            <div className="pa-modal-header">
              <div>
                <div className="pa-modal-title">{doctorModalFio || 'Врач'}</div>
                <div className="pa-muted">Протоколы врача</div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => setDoctorModalOpen(false)}>
                Закрыть
              </button>
            </div>

            <div className="pa-modal-toolbar">
              {(['recent', 'week', 'month', 'all'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pa-tab ${doctorModalPeriod === p ? 'pa-tab--active' : ''}`}
                  onClick={() => {
                    if (!doctorModalFio) return;
                    setDoctorModalPeriod(p);
                    void loadDoctorProtocols(doctorModalFio, p);
                  }}
                >
                  {p === 'recent' ? 'Недавние' : p === 'week' ? 'За неделю' : p === 'month' ? 'Месяц' : 'Все'}
                </button>
              ))}
              <div className="pa-modal-spacer" />
              <div className="pa-muted">{doctorModalData ? `Найдено: ${doctorModalData.total}` : ''}</div>
              {doctorModalLoading ? <div className="pa-inline-loading">Загрузка...</div> : null}
            </div>

            <div className="pa-modal-body">
              {!doctorModalData || doctorModalData.items.length === 0 ? (
                <div className="pa-muted">Нет протоколов</div>
              ) : (
                <div className="pa-modal-list">
                  {doctorModalData.items.map((it) => (
                    <button
                      key={it.url}
                      type="button"
                      className="pa-protocol-item"
                      onClick={() => {
                        setDoctorModalOpen(false);
                        void onSelectProtocol(it.url);
                      }}
                    >
                      <span className="pa-protocol-name">{it.fileName}</span>
                      <span className={it.status === 'OK' ? 'chip chip--ok' : it.status === 'ERROR' ? 'chip chip--error' : 'chip chip--default'}>
                        {it.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

