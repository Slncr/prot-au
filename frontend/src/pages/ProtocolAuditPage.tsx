/*import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

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
  diagnosisAssessment?: DiagnosisOrTherapyAssessment;
  therapyAssessment?: DiagnosisOrTherapyAssessment;
  recommendations?: string;
  sectionsCheck?: SectionsCheck;
  finalCheck?: FinalCheck;
  extractedText?: string;
};

type ProtocolListItem = {
  url: string;
  fileName: string;
  status: 'NEW' | 'OK' | 'ERROR';
  analyzedAt?: string;
};

type DoctorErrorsStat = {
  doctorFio: string;
  withErrors: number;
  total: number;
};

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 120000,
});

function formatAssessment(value: DiagnosisOrTherapyAssessment | undefined): React.ReactNode {
  if (!value) return '—';
  if (typeof value === 'string') return value;
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700}>
        {value.status || '—'}
      </Typography>
      {value.details ? (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {value.details}
        </Typography>
      ) : null}
    </Box>
  );
}

function normalizeSectionValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function isOkValue(v: unknown): boolean {
  const s = normalizeSectionValue(v).toUpperCase();
  return s === 'ОК' || s === 'OK';
}

function pickChipColor(v: unknown): 'success' | 'error' | 'default' {
  if (isOkValue(v)) return 'success';
  if (normalizeSectionValue(v).length) return 'error';
  return 'default';
}

export default function ProtocolAuditPage() {
  const [protocols, setProtocols] = useState<ProtocolListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const selectedProtocol = useMemo(
    () => (selectedUrl ? protocols.find((p) => p.url === selectedUrl) : null),
    [protocols, selectedUrl],
  );

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [originalDownloading, setOriginalDownloading] = useState(false);

  const [extractedTextOpen, setExtractedTextOpen] = useState(false);
  const [doctorStats, setDoctorStats] = useState<DoctorErrorsStat[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const res = await api.get<DoctorErrorsStat[]>('/stats/doctors-errors');
      setDoctorStats(res.data);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const syncList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await api.post<{ files: ProtocolListItem[] }>('/protocols/sync-list');
      setProtocols(res.data.files);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    // стартовая подгрузка
    void syncList();
    void loadStats();
  }, [syncList, loadStats]);

  const runAnalyze = useCallback(
    async (url: string) => {
      setLoadingAnalysis(true);
      try {
        const res = await api.post<{ analysis: AnalysisResult }>('/protocols/analyze', { url });
        const a = res.data.analysis;
        setAnalysis(a);

        const status: ProtocolListItem['status'] = a.finalCheck?.ok ? 'OK' : 'ERROR';
        const now = new Date().toISOString();
        setProtocols((prev) =>
          prev.map((p) =>
            p.url === url
              ? {
                  ...p,
                  status,
                  analyzedAt: p.analyzedAt || now,
                }
              : p,
          ),
        );
        void loadStats();
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
      setExtractedTextOpen(false);
      await runAnalyze(url);
    },
    [runAnalyze],
  );

  const downloadOriginal = useCallback(async () => {
    if (!selectedUrl) return;
    setOriginalDownloading(true);
    try {
      const res = await fetch(`/api/v1/protocols/original?url=${encodeURIComponent(selectedUrl)}`, {
        method: 'GET',
      });
      if (!res.ok) throw new Error('Failed to download');

      const blob = await res.blob();
      const filename =
        selectedProtocol?.fileName ||
        `protocol_${selectedUrl.split('/').pop() || 'pdf'}.pdf`;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } finally {
      setOriginalDownloading(false);
    }
  }, [selectedProtocol?.fileName, selectedUrl]);

  return (
    <Box sx={{ height: '100%', p: 2 }}>
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <Stack>
            <Typography variant="h6" fontWeight={800}>
              Анализ медицинских протоколов
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Статусы разделов, оценка диагноза/терапии и список врачей с ошибками.
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button variant="contained" onClick={() => void syncList()} disabled={loadingList}>
              {loadingList ? (
                <CircularProgress size={18} sx={{ mr: 1 }} />
              ) : (
                'Обновить список'
              )}
            </Button>
            <Button
              variant="outlined"
              onClick={() => void loadStats()}
              disabled={loadingStats}
            >
              {loadingStats ? <CircularProgress size={18} sx={{ mr: 1 }} /> : 'Обновить статистику'}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Grid container spacing={2} sx={{ height: 'calc(100% - 96px)' }}>
        <Grid item xs={12} md={3}>
          <Paper sx={{ p: 1, height: '100%', overflow: 'hidden' }}>
            <Box sx={{ p: 1 }}>
              <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>
                Протоколы
              </Typography>
              <Divider />
            </Box>

            <Box sx={{ p: 1, overflowY: 'auto', maxHeight: 'calc(100% - 54px)' }}>
              {protocols.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {loadingList ? 'Загрузка...' : 'Файлы не найдены'}
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {protocols.map((p) => {
                    const isActive = p.url === selectedUrl;
                    return (
                      <Button
                        key={p.url}
                        onClick={() => void onSelectProtocol(p.url)}
                        fullWidth
                        variant={isActive ? 'contained' : 'outlined'}
                        sx={{
                          justifyContent: 'flex-start',
                          textTransform: 'none',
                          borderColor: isActive ? 'transparent' : 'divider',
                          bgcolor: isActive ? 'indigo.700' : undefined,
                        }}
                      >
                        <Stack direction="row" alignItems="center" justifyContent="space-between" width="100%">
                          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pr: 1 }}>
                            {p.fileName}
                          </Typography>
                          <Chip
                            size="small"
                            label={p.status}
                            color={p.status === 'OK' ? 'success' : p.status === 'ERROR' ? 'error' : 'default'}
                          />
                        </Stack>
                      </Button>
                    );
                  })}
                </Stack>
              )}
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={9}>
          <Grid container spacing={2} sx={{ height: '100%' }}>
            <Grid item xs={12} md={8}>
              <Paper sx={{ p: 2, height: '100%', overflow: 'auto' }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                  <Typography variant="h6" fontWeight={900}>
                    Анализ
                  </Typography>
                  {loadingAnalysis ? <CircularProgress size={24} /> : null}
                </Stack>

                {!selectedUrl ? (
                  <Typography variant="body2" color="text.secondary">
                    Выберите протокол для анализа
                  </Typography>
                ) : !analysis ? (
                  <Typography variant="body2" color="text.secondary">
                    Анализируем...
                  </Typography>
                ) : (
                  <Box>
                    <Stack spacing={1}>
                      <Typography variant="body2">
                        <b>Дата приёма:</b> {analysis.dateOfAdmission || '—'}
                      </Typography>
                      <Typography variant="body2">
                        <b>Пациент:</b> {analysis.pacientFio || '—'}
                      </Typography>
                      <Typography variant="body2">
                        <b>Врач:</b> {analysis.doctorFio || '—'}
                      </Typography>
                      <Typography variant="body2">
                        <b>Итог:</b>{' '}
                        {analysis.finalCheck?.ok ? (
                          <Chip size="small" color="success" label="ОК" />
                        ) : (
                          <Chip size="small" color="error" label="Есть ошибки" />
                        )}
                      </Typography>
                    </Stack>

                    <Divider sx={{ my: 2 }} />

                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle1" fontWeight={900} sx={{ mb: 1 }}>
                        Проверка разделов
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                        {Object.entries(analysis.sectionsCheck || {}).length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            Нет данных по разделам
                          </Typography>
                        ) : (
                          Object.entries(analysis.sectionsCheck || {}).map(([k, v]) => (
                            <Chip
                              key={k}
                              label={`${k}: ${v || '—'}`}
                              color={pickChipColor(v)}
                              variant="outlined"
                              sx={{ mb: 1 }}
                            />
                          ))
                        )}
                      </Stack>
                    </Box>

                    <Divider sx={{ my: 2 }} />

                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle1" fontWeight={900} sx={{ mb: 1 }}>
                        Оценка диагноза
                      </Typography>
                      <Typography variant="body2">{formatAssessment(analysis.diagnosisAssessment)}</Typography>
                    </Box>

                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle1" fontWeight={900} sx={{ mb: 1 }}>
                        Оценка терапии
                      </Typography>
                      <Typography variant="body2">{formatAssessment(analysis.therapyAssessment)}</Typography>
                    </Box>

                    <Divider sx={{ my: 2 }} />

                    <Box sx={{ mb: 1 }}>
                      <Typography variant="subtitle1" fontWeight={900} sx={{ mb: 1 }}>
                        Рекомендации
                      </Typography>
                      <Box
                        sx={{
                          bgcolor: '#0b1222',
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1,
                          p: 1.5,
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
                        >
                          {analysis.recommendations || '—'}
                        </Typography>
                      </Box>
                    </Box>
                  </Box>
                )}
              </Paper>
            </Grid>

            <Grid item xs={12} md={4}>
              <Paper sx={{ p: 2, height: '100%', overflow: 'auto' }}>
                <Stack spacing={1}>
                  <Typography variant="h6" fontWeight={900}>
                    Оригинал (PDF)
                  </Typography>

                  {selectedProtocol ? (
                    <Typography variant="body2" color="text.secondary">
                      {selectedProtocol.fileName}
                    </Typography>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Выберите протокол
                    </Typography>
                  )}

                  <Button
                    variant="contained"
                    onClick={() => void downloadOriginal()}
                    disabled={!selectedUrl || originalDownloading}
                    sx={{ mt: 1 }}
                  >
                    {originalDownloading ? (
                      <CircularProgress size={18} sx={{ mr: 1 }} />
                    ) : null}
                    Скачать PDF
                  </Button>

                  <Divider sx={{ my: 1.5 }} />

                  <Stack direction="row" alignItems="center" justifyContent="space-between">
                    <Typography variant="subtitle1" fontWeight={900}>
                      Статистика врачей с ошибками
                    </Typography>
                    {loadingStats ? <CircularProgress size={18} /> : null}
                  </Stack>

                  <Typography variant="caption" color="text.secondary">
                    {doctorStats.length ? `Топ врачей: ${doctorStats.length}` : 'Пока нет данных'}
                  </Typography>

                  <Box sx={{ mt: 1 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Врач</TableCell>
                          <TableCell align="right">Ошибок</TableCell>
                          <TableCell align="right">Всего</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {doctorStats.slice(0, 10).map((s) => (
                          <TableRow key={s.doctorFio}>
                            <TableCell sx={{ maxWidth: 180 }}>
                              <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.doctorFio}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Chip size="small" color="error" label={s.withErrors} />
                            </TableCell>
                            <TableCell align="right">
                              <Typography variant="body2">{s.total}</Typography>
                            </TableCell>
                          </TableRow>
                        ))}
                        {doctorStats.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} align="center">
                              <Typography variant="body2" color="text.secondary">
                                Нет записей с ошибками
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </Box>

                  <Divider sx={{ my: 1.5 }} />

                  <Stack direction="row" alignItems="center" justifyContent="space-between">
                    <Typography variant="subtitle1" fontWeight={900}>
                      Текст протокола
                    </Typography>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setExtractedTextOpen((v) => !v)}
                      disabled={!analysis?.extractedText}
                    >
                      {extractedTextOpen ? 'Скрыть' : 'Показать'}
                    </Button>
                  </Stack>
                  {extractedTextOpen ? (
                    <Box
                      sx={{
                        mt: 1,
                        bgcolor: '#0b1222',
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        p: 1,
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{
                          whiteSpace: 'pre-wrap',
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                        }}
                      >
                        {analysis?.extractedText || '—'}
                      </Typography>
                    </Box>
                  ) : null}
                </Stack>
              </Paper>
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    </Box>
  );
}
*/

export { default } from './ProtocolAuditPagePlain';

