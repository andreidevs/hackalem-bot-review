import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowLeft,
  Search,
  SlidersHorizontal,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  BookOpen,
  Layers,
  BarChart3,
  MessageSquare,
  Settings2,
  RefreshCw,
  Play,
  Pause,
  Download,
  X,
  ExternalLink,
  FileText,
  Code2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Plus,
  Send,
  FolderGit2,
  Activity,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type {
  Project,
  Track,
  Analysis,
  Snapshot,
  Job,
  HarnessInfo,
  Evidence,
  SourceFile,
} from "../shared/types";
import { STATUS, VERDICTS, COMMON_RUBRIC } from "../shared/types";
import "./style.css";
const fmt = (n: number) => new Intl.NumberFormat("ru-RU").format(n);
const date = (s: string) =>
  new Date(s).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
async function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const res = await fetch(
    "/api" + path,
    body === undefined
      ? undefined
      : {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-HackAlem": "local",
          },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}
function useApi<T>(path: string | null, revision: unknown = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState("");
  const previousPath = useRef(path);
  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      setData(null);
      setError("");
    }
    if (!path) return;
    let current = true;
    setError("");
    api<T>(path)
      .then((d) => {
        if (current) setData(d);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [path, revision]);
  return { data: previousPath.current === path ? data : null, error };
}
function navigate(path: string) {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
function Link({
  to,
  children,
  className = "",
  ...rest
}: React.PropsWithChildren<{
  to: string;
  className?: string;
  title?: string;
}>) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          navigate(to);
        }
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
function Empty({
  title,
  detail,
  icon: Icon = FolderGit2,
}: {
  title: string;
  detail: string;
  icon?: typeof Search;
}) {
  return (
    <div className="empty">
      <Icon size={36} strokeWidth={1.3} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error">
      <AlertCircle size={16} />
      {message}
    </div>
  ) : null;
}
function Loading() {
  return (
    <div className="loading">
      <Loader2 size={18} className="spin" />
      Загрузка…
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={`badge ${status === "analyzed" ? "green" : status === "error" || status === "stale" ? "amber" : ""}`}
    >
      <span className="dot" />
      {STATUS[status] || status}
    </span>
  );
}
function Markdown({ text, base }: { text: string; base?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a
              href={
                href?.startsWith("#")
                  ? href
                  : href && base
                    ? new URL(href, base).href
                    : href
              }
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a
              href={src && base ? new URL(src, base).href : src}
              target="_blank"
              rel="noreferrer"
            >
              [Изображение: {alt || "открыть"}]
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
type Stats = {
  total: number;
  snapshots: number;
  analyzed: number;
  empty: number;
  errors: number;
  queued: number;
  paused: boolean;
  pauseReason: string;
  workerHeartbeat: string | null;
  running: Job[];
};
function App() {
  const [location, setLocation] = useState(
      window.location.pathname + window.location.search,
    ),
    [stats, setStats] = useState<Stats | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [toast, setToast] = useState(""),
    [startingAll, setStartingAll] = useState(false),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => {
    const change = () =>
      setLocation(window.location.pathname + window.location.search);
    addEventListener("popstate", change);
    return () => removeEventListener("popstate", change);
  }, []);
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (e) => setStats(JSON.parse(e.data));
    return () => events.close();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const { data: tracks } = useApi<Track[]>(
    "/tracks",
    `${stats?.analyzed}:${revision}`,
  );
  const path = location.split("?")[0],
    params = new URLSearchParams(location.split("?")[1]);
  const currentTrack = params.get("track");
  const toggle = (id: number) =>
    setSelected((s) =>
      s.includes(id)
        ? s.filter((x) => x !== id)
        : s.length < 5
          ? [...s, id]
          : s,
    );
  async function sync() {
    try {
      await api("/jobs", { type: "sync" });
      setToast("Импорт добавлен в очередь");
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  async function analyzeAll() {
    if (startingAll) return;
    setStartingAll(true);
    try {
      const result = await api<{
        added: number;
        alreadyQueued: number;
        completed: number;
        empty: number;
      }>("/jobs/analyze-all", {});
      setToast(
        `Оценка запущена: добавлено ${result.added}, уже в очереди ${result.alreadyQueued}. Готовые оценки: ${result.completed}, пустые проекты: ${result.empty}.`,
      );
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setStartingAll(false);
    }
  }
  const nav = [
    ["/", "Каталог", Layers],
    ["/rankings", "Рейтинги", BarChart3],
    ["/compare", "Сравнение", SlidersHorizontal],
    ["/chat", "AI-ассистент", MessageSquare],
  ] as const;
  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            h<span>↗</span>
          </span>
          <span>
            hackalem<span className="brand-sub">PROJECT EXPLORER</span>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="org-icon">B</span>
          <span>
            BAITC-Hacks<small>Хакатон · 2026</small>
          </span>
          <span className="local-dot" />
        </div>
        <nav>
          {nav.map(([url, title, Icon]) => (
            <Link
              key={url}
              to={url}
              className={`nav-item ${path === url && !currentTrack ? "active" : ""}`}
            >
              <Icon size={18} />
              {title}
              {url === "/compare" && selected.length > 0 && (
                <span className="nav-count">{selected.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="section-label">
          ТРЕКИ <span>12</span>
        </div>
        <nav className="track-nav">
          {tracks?.map((t) => (
            <Link
              to={`/?track=${t.id}`}
              key={t.id}
              className={`track-link ${path === "/" && Number(currentTrack) === t.id ? "active" : ""}`}
            >
              <span className="track-number">
                {String(t.id).padStart(2, "0")}
              </span>
              <span>{t.name}</span>
              <small>{t.count || "—"}</small>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            to="/methodology"
            className={`nav-item ${path === "/methodology" ? "active" : ""}`}
          >
            <BookOpen size={17} />
            Методика и источники
          </Link>
          <Link
            to="/settings"
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
          >
            <Settings2 size={17} />
            Обработка и настройки
          </Link>
          <div className="local-status">
            <span className="dot" />
            Локальное рабочее пространство
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">Рабочее пространство</span>
            <span className="slash">/</span>
            <span>
              {path === "/"
                ? "Проекты"
                : path.startsWith("/project")
                  ? "Карточка проекта"
                  : nav.find((n) => n[0] === path)?.[1] || "Настройки"}
            </span>
          </div>
          <div className="top-actions">
            <span className="preliminary">
              <span className="dot" />
              Предварительная AI-оценка
            </span>
            <button className="button" onClick={sync}>
              <RefreshCw size={15} />
              Обновить каталог
            </button>
            <button
              className="button primary"
              onClick={analyzeAll}
              disabled={startingAll || !stats?.total}
              title="Запустить очередь для всех проектов без актуальной оценки. Недостающие исходники загрузятся автоматически."
            >
              {startingAll ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Play size={15} />
              )}
              {startingAll ? "Запускаем…" : "Оценить все проекты"}
            </button>
            <span className="avatar">A</span>
          </div>
        </header>
        <div className="content">
          {path === "/" ? (
            <Catalog
              tracks={tracks || []}
              stats={stats}
              params={params}
              selected={selected}
              toggle={toggle}
              revision={revision}
              sync={sync}
            />
          ) : path.startsWith("/project/") ? (
            <ProjectPage
              id={Number(path.split("/")[2])}
              tracks={tracks || []}
              params={params}
              revision={`${revision}:${stats?.analyzed}`}
              refresh={refresh}
            />
          ) : path.startsWith("/specification/") ? (
            <SpecificationPage
              hash={path.split("/")[2]}
              line={Number(params.get("line")) || 1}
            />
          ) : path === "/rankings" ? (
            <Rankings
              tracks={tracks || []}
              params={params}
              revision={stats?.analyzed}
            />
          ) : path === "/compare" ? (
            <Compare
              ids={selected}
              clear={() => setSelected([])}
              revision={stats?.analyzed}
            />
          ) : path === "/chat" ? (
            <Chat ids={selected} stats={stats} />
          ) : path === "/methodology" ? (
            <Methodology tracks={tracks || []} />
          ) : path === "/settings" ? (
            <Settings stats={stats} revision={revision} refresh={refresh} />
          ) : (
            <Empty
              title="Страница не найдена"
              detail="Откройте каталог проектов."
            />
          )}
        </div>
        <footer className="footer">
          <span>HackAlem Research Workspace</span>
          <span>
            Снимки GitHub · Проверяемые источники · {new Date().getFullYear()}
          </span>
        </footer>
      </main>
      {selected.length > 0 && path === "/" && (
        <div className="selection-bar">
          <span>
            <strong>{selected.length}</strong> из 5 проектов
          </span>
          <button className="text-button" onClick={() => setSelected([])}>
            Сбросить
          </button>
          <button
            className="button primary"
            disabled={selected.length < 2}
            onClick={() => navigate("/compare")}
          >
            Сравнить проекты
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Catalog({
  tracks,
  stats,
  params,
  selected,
  toggle,
  revision,
  sync,
}: {
  tracks: Track[];
  stats: Stats | null;
  params: URLSearchParams;
  selected: number[];
  toggle: (id: number) => void;
  revision: number;
  sync: () => void;
}) {
  const [search, setSearch] = useState(params.get("q") || "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setSearch(params.get("q") || ""), [params.get("q")]);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    navigate("/?" + next);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== (params.get("q") || "")) change("q", search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)
      ) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const query = params.toString();
  const { data, error } = useApi<{
    items: Project[];
    total: number;
    page: number;
    limit: number;
  }>(
    "/projects?" + query,
    `${revision}:${stats?.total}:${stats?.snapshots}:${stats?.analyzed}`,
  );
  const track = tracks.find((t) => t.id === Number(params.get("track")));
  const coverage = stats?.total
    ? Math.round((stats.analyzed / stats.total) * 100)
    : 0;
  return (
    <>
      <div className="eyebrow">
        <span className="dot" />
        HACKALEM AI · КАТАЛОГ РЕПОЗИТОРИЕВ
      </div>
      <div className="page-heading">
        <div>
          <h1>
            {track ? track.name : "Каталог проектов"}
            <span className="heading-count">{fmt(data?.total || 0)}</span>
          </h1>
          <p>
            {track
              ? track.caseName
              : "Исследуйте решения, изучайте код и находите сильные проекты."}
          </p>
        </div>
        <a
          className="text-link"
          href="https://github.com/BAITC-Hacks"
          target="_blank"
          rel="noreferrer"
        >
          Организация на GitHub
          <ArrowUpRight size={16} />
        </a>
      </div>
      <div className="overview">
        <div>
          <span>В каталоге</span>
          <strong>
            {fmt(stats?.total || 0)}
            <small>репозиториев</small>
          </strong>
        </div>
        <div>
          <span>Исходники загружены</span>
          <strong>
            {fmt(stats?.snapshots || 0)}
            <small>снимков</small>
          </strong>
        </div>
        <div>
          <span>Предварительно оценено</span>
          <strong>
            {fmt(stats?.analyzed || 0)}
            <small>проектов</small>
          </strong>
        </div>
        <div className="coverage">
          <span>
            Покрытие анализа <b>{coverage}%</b>
          </span>
          <div className="progress-bar">
            <i style={{ width: `${coverage}%` }} />
          </div>
          <small>
            {stats?.paused
              ? "Обработка на паузе"
              : stats?.running[0]?.type === "analyze"
                ? "Анализ продолжается"
                : stats?.queued
                  ? "Очередь обрабатывается"
                  : "Готов к работе"}
            <Link to="/settings">
              <ArrowRight size={14} />
            </Link>
          </small>
        </div>
      </div>
      <div className="tabs">
        <button
          className={!params.get("status") ? "active" : ""}
          onClick={() => change("status", "")}
        >
          Все проекты <span>{fmt(stats?.total || 0)}</span>
        </button>
        <button
          className={params.get("status") === "analyzed" ? "active" : ""}
          onClick={() => change("status", "analyzed")}
        >
          Оценённые
        </button>
        <button
          className={params.get("status") === "unclassified" ? "active" : ""}
          onClick={() => change("status", "unclassified")}
        >
          Уточнить трек
        </button>
      </div>
      <div className="filters">
        <label className="search-field">
          <Search size={18} />
          <input
            ref={input}
            aria-label="Поиск проектов"
            placeholder="Поиск по названию, команде, README…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button aria-label="Очистить поиск" onClick={() => setSearch("")}>
              <X size={14} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>
        <select
          aria-label="Трек"
          value={params.get("track") || ""}
          onChange={(e) => change("track", e.target.value)}
        >
          <option value="">Все треки</option>
          <option value="0">Трек не определён</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          className="tech-filter"
          aria-label="Технология"
          placeholder="Технология или тег"
          value={params.get("technology") || ""}
          onChange={(e) => change("technology", e.target.value)}
        />
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : !data.items.length ? (
        <>
          <Empty
            title={
              stats?.total
                ? "Ничего не найдено"
                : "Каталог готов к первому импорту"
            }
            detail={
              stats?.total
                ? "Измените поисковый запрос или фильтры."
                : "Загрузите публичные репозитории BAITC-Hacks. Они появятся здесь по мере обработки."
            }
          />
          {!stats?.total && (
            <div className="center">
              <button className="button primary" onClick={sync}>
                <Plus size={16} />
                Импортировать проекты
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="table-wrap">
          <table className="projects-table">
            <thead>
              <tr>
                <th className="check-col"></th>
                <th>ПРОЕКТ / КОМАНДА</th>
                <th>ТРЕК</th>
                <th>ТЕХНОЛОГИИ</th>
                <th>СТАТУС</th>
                <th className="score-col">ОЦЕНКА</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr
                  key={p.id}
                  className={selected.includes(p.id) ? "selected" : ""}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Сравнить ${p.team}`}
                      checked={selected.includes(p.id)}
                      disabled={
                        !selected.includes(p.id) && selected.length >= 5
                      }
                      onChange={() => toggle(p.id)}
                    />
                  </td>
                  <td>
                    <Link to={`/project/${p.id}`} className="project-name">
                      <span className="project-symbol">
                        {p.team.slice(0, 2).toUpperCase()}
                      </span>
                      <span>
                        <strong>{p.team}</strong>
                        <small>{p.summary || p.name}</small>
                      </span>
                    </Link>
                  </td>
                  <td>
                    {p.trackId ? (
                      <span className="track-cell">
                        <b>{String(p.trackId).padStart(2, "0")}</b>
                        {tracks.find((t) => t.id === p.trackId)?.name}
                      </span>
                    ) : (
                      <span className="muted">Не определён</span>
                    )}
                  </td>
                  <td>
                    <div className="tags">
                      {[
                        ...new Set(
                          [
                            p.language,
                            ...p.technologies,
                            ...(p.tags || []),
                          ].filter(Boolean),
                        ),
                      ]
                        .slice(0, 2)
                        .map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                    </div>
                  </td>
                  <td>
                    <Badge status={p.status} />
                  </td>
                  <td className="score-col">
                    {p.total != null && !p.stale ? (
                      <span className="score">
                        {p.total}
                        <small>/100</small>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <Link to={`/project/${p.id}`} title="Открыть проект">
                      <ArrowUpRight size={17} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <div className="pagination">
          <span>
            Показано {(data.page - 1) * data.limit + 1}–
            {Math.min(data.page * data.limit, data.total)} из {fmt(data.total)}
          </span>
          <div>
            <button
              className="icon-button"
              aria-label="Предыдущая страница"
              disabled={data.page <= 1}
              onClick={() => change("page", String(data.page - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>
              Страница {data.page} из {Math.ceil(data.total / data.limit)}
            </span>
            <button
              className="icon-button"
              aria-label="Следующая страница"
              disabled={data.page * data.limit >= data.total}
              onClick={() => change("page", String(data.page + 1))}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      )}
      <div className="catalog-note">
        <BookOpen size={15} />
        <span>
          Каждая оценка привязана к версии кода и требованиям кейса.
          Работоспособность требует экспертной проверки.
        </span>
      </div>
    </>
  );
}
function EvidenceLinks({
  items,
  projectId,
  snapshotId,
}: {
  items: Evidence[];
  projectId: number;
  snapshotId: number;
}) {
  return (
    <div className="evidence-links">
      {items.map((e, i) => (
        <Link
          key={i}
          to={`/project/${projectId}?file=${encodeURIComponent(e.path)}&snapshot=${snapshotId}&line=${e.start}`}
          title={e.quote}
        >
          <Code2 size={12} />
          {e.path}:{e.start}
          {e.end !== e.start ? `–${e.end}` : ""}
        </Link>
      ))}
    </div>
  );
}
type Detail = {
  demoUrls: string[];
  project: Project;
  snapshot:
    | (Omit<Snapshot, "files"> & { files: Omit<SourceFile, "text">[] })
    | null;
  analysis: Analysis | null;
  history: {
    id: number;
    total: number;
    commonTotal: number;
    createdAt: string;
    stale: boolean;
    snapshotId: number;
  }[];
  notes: { id: number; text: string; created_at: string }[];
};
function ProjectPage({
  id,
  tracks,
  params,
  revision,
  refresh,
}: {
  id: number;
  tracks: Track[];
  params: URLSearchParams;
  revision: string;
  refresh: () => void;
}) {
  const { data, error } = useApi<Detail>(`/projects/${id}`, revision);
  const [tab, setTab] = useState("overview"),
    [notice, setNotice] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    setTab("overview");
    setNotice("");
  }, [id]);
  const oldId = params.get("analysis");
  const { data: oldAnalysis } = useApi<Analysis>(
    oldId ? `/analyses/${oldId}` : null,
  );
  const activeAnalysis = oldId ? oldAnalysis : data?.analysis;
  const { data: savedTrack } = useApi<Track>(
    activeAnalysis?.trackId
      ? `/specifications/${activeAnalysis.specHash}`
      : null,
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const { project: p, snapshot: s } = data;
  const a = oldId ? oldAnalysis : data.analysis;
  const track =
    savedTrack || tracks.find((t) => t.id === (a?.trackId ?? p.trackId));
  async function action(type: string) {
    try {
      await api("/jobs", { type, projectId: id });
      setNotice("Задание добавлено в очередь");
      refresh();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  return (
    <>
      <Link to="/" className="back">
        <ArrowLeft size={15} />
        Все проекты
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {track
              ? `${String(track.id).padStart(2, "0")} / ${track.name}`
              : "ТРЕК НЕ ОПРЕДЕЛЁН"}
          </div>
          <h1>{p.team}</h1>
          <p>{a?.summary || p.summary || p.description}</p>
        </div>
        <a href={p.url} target="_blank" rel="noreferrer" className="button">
          GitHub
          <ArrowUpRight size={16} />
        </a>
      </div>
      <div className="project-meta">
        {data.demoUrls?.map((url, i) => (
          <a
            className="button small"
            href={url}
            key={url}
            target="_blank"
            rel="noreferrer"
            title="Ссылка из README; работоспособность не проверена"
          >
            Демо {i + 1}
            <ArrowUpRight size={13} />
          </a>
        ))}
        <Badge status={a?.stale ? "stale" : p.status} />
        <span>
          <GitBranch size={14} />
          {p.branch} · {p.sha?.slice(0, 8) || "Нет снимка"}
        </span>
        <span>Загружен {date(p.syncedAt)}</span>
        <button className="button small" onClick={() => action("snapshot")}>
          <RefreshCw size={13} />
          Обновить снимок
        </button>
        <button
          className="button small primary"
          disabled={!s}
          onClick={() => action("analyze")}
        >
          <Play size={13} />
          Анализировать
        </button>
      </div>
      {notice && (
        <div className="notice">
          {notice}
          <Link to="/settings">
            Перейти к очереди <ArrowRight size={14} />
          </Link>
        </div>
      )}
      {p.error && <ErrorBox message={p.error} />}
      {params.get("file") ? (
        <SourceViewer
          snapshotId={Number(params.get("snapshot")) || s?.id || 0}
          path={params.get("file")!}
          line={Number(params.get("line")) || 1}
          close={() => navigate(`/project/${id}`)}
        />
      ) : (
        <>
          <div className="tabs">
            {[
              ["overview", "Обзор"],
              ["readme", "README"],
              ["assessment", "Оценка и доказательства"],
              ["files", "Исходники"],
              ["history", "История"],
            ].map(([key, title]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={tab === key ? "active" : ""}
              >
                {title}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <div className="detail-grid">
              <section>
                <h2>О проекте</h2>
                <div className="technology-tags">
                  {[
                    ...(a?.technologies || p.technologies),
                    ...(a?.tags || p.tags || []),
                  ].map((tag) => (
                    <span className="badge" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="body-text">
                  {a?.summary || "AI-обзор появится после анализа исходников."}
                </p>
                {a && (
                  <>
                    {[
                      ["Архитектура", a.architecture],
                      ["Роль искусственного интеллекта", a.aiUsage],
                      ["Воспроизводимость", a.reproducibility],
                    ].map(([title, text]) => (
                      <section className="text-section" key={title}>
                        <h3>{title}</h3>
                        <p>{text}</p>
                      </section>
                    ))}
                    <div className="two-columns">
                      <section>
                        <h3>Сильные стороны</h3>
                        <ul>
                          {a.strengths.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </section>
                      <section>
                        <h3>Ограничения</h3>
                        <ul>
                          {a.weaknesses.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </section>
                    </div>
                  </>
                )}
                <section className="notes">
                  <h3>Заметки эксперта</h3>
                  {data.notes.map((n) => (
                    <div key={n.id} className="note">
                      <small>{date(n.created_at)}</small>
                      <p>{n.text}</p>
                    </div>
                  ))}
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ваши наблюдения и вопросы к проекту"
                    aria-label="Заметка эксперта"
                  />
                  <button
                    className="button"
                    disabled={!note.trim()}
                    onClick={async () => {
                      try {
                        await api(`/projects/${id}/notes`, { text: note });
                        setNote("");
                        refresh();
                      } catch (e) {
                        setNotice((e as Error).message);
                      }
                    }}
                  >
                    Сохранить заметку
                  </button>
                </section>
              </section>
              <aside className="inspector">
                <h3>Предварительная оценка</h3>
                <div className="large-score">
                  {a?.total ?? "—"}
                  <small>/100</small>
                </div>
                <p className="muted">
                  По методике трека. Запуск проекта не выполнялся.
                </p>
                <div className="divider" />
                <label className="field-label">
                  Основной трек
                  <select
                    value={p.manualTrackId ?? ""}
                    onChange={async (e) => {
                      try {
                        await api(
                          `/projects/${id}`,
                          {
                            trackId: e.target.value
                              ? Number(e.target.value)
                              : null,
                          },
                          "PATCH",
                        );
                        refresh();
                      } catch (error) {
                        setNotice((error as Error).message);
                      }
                    }}
                  >
                    <option value="">
                      Автоматически
                      {p.trackId
                        ? ` (${tracks.find((t) => t.id === p.trackId)?.name})`
                        : ""}
                    </option>
                    {tracks.map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                {a && a.candidates.length > 0 && (
                  <p className="muted">
                    Кандидаты:{" "}
                    {a.candidates
                      .map((id) => tracks.find((t) => t.id === id)?.name)
                      .join(", ")}
                  </p>
                )}
                {track && (
                  <a
                    href={track.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    <FileText size={15} />
                    Техническое задание
                    <ArrowUpRight size={14} />
                  </a>
                )}
                <div className="divider" />
                <h4>Покрытие источников</h4>
                <p>
                  {s?.files.length || 0} файлов прочитано
                  <br />
                  {s?.tree.filter((f) => f.reason).length || 0} пропущено
                </p>
                {a && (
                  <small className="muted">
                    {a.harness} · {a.model}
                    <br />
                    {date(a.createdAt)}
                    <br />
                    Методика {a.methodVersion}
                  </small>
                )}
              </aside>
            </div>
          )}
          {tab === "readme" &&
            (s?.readme ? (
              <>
                <div className="source-caption">
                  <FileText size={15} />
                  {s.readmePath}
                  <span>{s.sha.slice(0, 8)}</span>
                </div>
                <Markdown
                  text={s.readme}
                  base={`${p.url}/blob/${s.sha}/${s.readmePath}`}
                />
              </>
            ) : (
              <Empty
                title="README отсутствует"
                detail={
                  s
                    ? "В сохранённом снимке README не найден или был пропущен. Откройте исходники для подробностей."
                    : "Дождитесь загрузки снимка проекта."
                }
                icon={FileText}
              />
            ))}
          {tab === "assessment" &&
            (a ? (
              <Assessment analysis={a} track={track} projectId={id} />
            ) : (
              <Empty
                title="Оценка ещё не готова"
                detail="Запустите анализ или дождитесь своей очереди. Необработанный проект не получает нулевой балл."
              />
            ))}
          {tab === "files" &&
            (s ? (
              <>
                <div className="source-caption">
                  Снимок {s.sha} · {s.files.length} доступных файлов
                </div>
                <table className="simple-table">
                  <thead>
                    <tr>
                      <th>Файл</th>
                      <th>Размер</th>
                      <th>Доступность</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.tree.map((f, i) => (
                      <tr key={i}>
                        <td>
                          {f.reason ? (
                            f.path
                          ) : (
                            <Link
                              to={`/project/${id}?file=${encodeURIComponent(f.path)}&snapshot=${s.id}`}
                            >
                              {f.path}
                            </Link>
                          )}
                        </td>
                        <td>{fmt(f.bytes)} Б</td>
                        <td className="muted">
                          {f.reason || "Включён в снимок"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <Loading />
            ))}
          {tab === "history" && (
            <>
              <h2>История оценок</h2>
              {data.history.length ? (
                data.history.map((h) => (
                  <div className="history-row" key={h.id}>
                    <Link to={`/project/${id}?analysis=${h.id}`}>
                      {date(h.createdAt)}
                    </Link>
                    <span>
                      По ТЗ: {h.total ?? "—"} · Общая: {h.commonTotal}
                    </span>
                    <Badge status={h.stale ? "stale" : "analyzed"} />
                  </div>
                ))
              ) : (
                <p className="muted">Пока нет сохранённых оценок.</p>
              )}
            </>
          )}
          {oldId && a && tab !== "assessment" && (
            <>
              <h2>Сохранённая оценка #{a.id}</h2>
              <Assessment
                analysis={a}
                track={savedTrack || tracks.find((t) => t.id === a.trackId)}
                projectId={id}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
function Assessment({
  analysis: a,
  track,
  projectId,
}: {
  analysis: Analysis;
  track?: Track;
  projectId: number;
}) {
  return (
    <>
      <div className="notice">
        Предварительный анализ кода · {a.model} · {date(a.createdAt)}
        {a.stale && <strong>Оценка устарела</strong>}
      </div>
      {track?.rubricOrigin === "analytical" && (
        <p className="muted">
          Веса в ТЗ отсутствуют. Используется общая аналитическая шкала.
        </p>
      )}
      <div className="score-list">
        {a.scores.map((s) => (
          <div key={s.id}>
            <div className="score-heading">
              <h3>{track?.rubric.find((c) => c.id === s.id)?.title || s.id}</h3>
              <strong>
                {s.points}
                <span>/{track?.rubric.find((c) => c.id === s.id)?.max}</span>
              </strong>
            </div>
            <p>{s.rationale}</p>
            <EvidenceLinks
              items={s.evidence}
              projectId={projectId}
              snapshotId={a.snapshotId}
            />
          </div>
        ))}
      </div>
      <h2>Требования кейса</h2>
      {!track && (
        <p className="muted">
          Трек не определён. Уточните классификацию, чтобы получить оценку по
          конкретному ТЗ.
        </p>
      )}
      {a.findings.map((f, i) => (
        <div className="finding" key={i}>
          <span
            className={`badge ${f.verdict === "code" ? "green" : f.verdict === "contradiction" ? "amber" : ""}`}
          >
            {VERDICTS[f.verdict]}
          </span>
          <h3>
            {track?.requirements.find((r) => r.id === f.requirementId)?.text ||
              f.requirementId}
          </h3>
          {track?.requirements.find((r) => r.id === f.requirementId) && (
            <Link
              className="text-link"
              to={`/specification/${track.hash}?line=${track.requirements.find((r) => r.id === f.requirementId)!.sourceLine}`}
            >
              {
                {
                  required: "Обязательно",
                  optional: "Дополнительно",
                  constraint: "Ограничение",
                }[
                  track.requirements.find((r) => r.id === f.requirementId)!.kind
                ]
              }{" "}
              · ТЗ, строка{" "}
              {
                track.requirements.find((r) => r.id === f.requirementId)!
                  .sourceLine
              }
            </Link>
          )}
          <p>{f.explanation}</p>
          <EvidenceLinks
            items={f.evidence}
            projectId={projectId}
            snapshotId={a.snapshotId}
          />
        </div>
      ))}
      <h2>Вопросы для экспертной проверки</h2>
      <ul className="expert-questions">
        {a.expertQuestions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
      <details>
        <summary>Общая аналитическая шкала · {a.commonTotal}/100</summary>
        {a.commonScores.map((s) => (
          <div className="finding" key={s.id}>
            <h3>
              {COMMON_RUBRIC.find((c) => c.id === s.id)?.title || s.id}:{" "}
              {s.points}/{COMMON_RUBRIC.find((c) => c.id === s.id)?.max}
            </h3>
            <p>{s.rationale}</p>
            <EvidenceLinks
              items={s.evidence}
              projectId={projectId}
              snapshotId={a.snapshotId}
            />
          </div>
        ))}
      </details>
    </>
  );
}
function SourceViewer({
  snapshotId,
  path,
  line,
  close,
}: {
  snapshotId: number;
  path: string;
  line: number;
  close: () => void;
}) {
  const { data, error } = useApi<SourceFile & { sha: string }>(
    `/snapshots/${snapshotId}/file?path=${encodeURIComponent(path)}`,
  );
  useEffect(() => {
    if (data)
      document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" });
  }, [data, line]);
  return (
    <div className="source-viewer">
      <div className="source-caption">
        <Code2 size={16} />
        {path}
        <span title={data?.sha}>
          Снимок {data?.sha?.slice(0, 12) || `#${snapshotId}`}
        </span>
        <button
          className="icon-button"
          aria-label="Закрыть исходник"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <ErrorBox message={error} />
      {data ? (
        <pre>
          {data.text.split("\n").map((text, i) => (
            <div
              id={`L${i + 1}`}
              className={i + 1 === line ? "highlight" : ""}
              key={i}
            >
              <span>{i + 1}</span>
              <code>{text || " "}</code>
            </div>
          ))}
        </pre>
      ) : (
        !error && <Loading />
      )}
    </div>
  );
}
function Rankings({
  tracks,
  params,
  revision,
}: {
  tracks: Track[];
  params: URLSearchParams;
  revision: unknown;
}) {
  const track = params.get("track") || "";
  const { data, error } = useApi<(Project & { score: number; rank: number })[]>(
    "/rankings" + (track ? `?track=${track}` : ""),
    revision,
  );
  return (
    <>
      <div className="eyebrow">СРАВНИТЕЛЬНЫЙ АНАЛИЗ</div>
      <div className="page-heading">
        <div>
          <h1>Рейтинги проектов</h1>
          <p>
            {track
              ? "Оценки по требованиям выбранного кейса."
              : "Общий аналитический рейтинг по единой шкале 25/25/25/15/10."}
          </p>
        </div>
        <div className="button-group">
          <a
            className="button"
            href={`/api/rankings/export?format=csv${track ? `&track=${track}` : ""}`}
          >
            <Download size={15} />
            CSV
          </a>
          <a
            className="button"
            href={`/api/rankings/export?format=md${track ? `&track=${track}` : ""}`}
          >
            Markdown
          </a>
        </div>
      </div>
      <div className="notice">
        Это предварительное ранжирование доступных материалов. Итоговые места
        определяет жюри. Неполные и устаревшие оценки исключены.
      </div>
      <div className="filters">
        <select
          aria-label="Рейтинг трека"
          value={track}
          onChange={(e) =>
            navigate(
              "/rankings" + (e.target.value ? `?track=${e.target.value}` : ""),
            )
          }
        >
          <option value="">Общий аналитический рейтинг</option>
          {tracks.map((t) => (
            <option value={t.id} key={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="muted">{data?.length || 0} оценённых проектов</span>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <Empty
          title="Рейтинг ещё формируется"
          detail="Здесь появятся проекты с завершённым анализом. Баллы не генерируются без изучения источников."
          icon={BarChart3}
        />
      ) : (
        <div className="ranking-list">
          {data.map((p) => (
            <Link key={p.id} to={`/project/${p.id}`} className="ranking-row">
              <span className="rank">{String(p.rank).padStart(2, "0")}</span>
              <div>
                <h3>{p.team}</h3>
                <p>{p.summary}</p>
                <small>
                  {tracks.find((t) => t.id === p.trackId)?.name ||
                    "Трек не определён"}
                </small>
              </div>
              <span className="ranking-score">
                {p.score}
                <small>/100</small>
              </span>
              <ArrowUpRight size={18} />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
function Compare({
  ids,
  clear,
  revision,
}: {
  ids: number[];
  clear: () => void;
  revision?: number;
}) {
  const [items, setItems] = useState<
      { project: Project; analysis: Analysis | null; track: Track | null }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (ids.length >= 2)
      api<typeof items>("/comparisons", { ids })
        .then(setItems)
        .catch((e) => setError(e.message));
  }, [ids.join(","), revision]);
  const { data: method } = useApi<{
    commonRubric: { id: string; title: string; max: number }[];
  }>("/methodology");
  const requirements = [
    ...new Map(
      items.flatMap((x) =>
        (x.track?.requirements || []).map(
          (r) =>
            [
              `${x.track!.hash}:${r.id}`,
              { ...r, hash: x.track!.hash, trackName: x.track!.name },
            ] as const,
        ),
      ),
    ).values(),
  ];
  return (
    <>
      <div className="eyebrow">ПРОЕКТЫ РЯДОМ</div>
      <div className="page-heading">
        <div>
          <h1>Сравнение проектов</h1>
          <p>Требования, подходы и подтверждённые возможности в одном месте.</p>
        </div>
        {ids.length > 0 && (
          <button className="button" onClick={clear}>
            Очистить выбор
          </button>
        )}
      </div>
      <ErrorBox message={error} />
      {ids.length < 2 ? (
        <Empty
          title="Выберите от 2 до 5 проектов"
          detail="Отметьте проекты в каталоге, затем вернитесь сюда."
          icon={SlidersHorizontal}
        />
      ) : !items.length ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Параметр</th>
                {items.map((x) => (
                  <th key={x.project.id}>
                    <Link to={`/project/${x.project.id}`}>
                      {x.project.team}
                      <ArrowUpRight size={14} />
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["Суть решения", "summary"],
                ["Архитектура", "architecture"],
                ["Использование AI", "aiUsage"],
                ["Воспроизводимость", "reproducibility"],
                ["Сильные стороны", "strengths"],
                ["Ограничения", "weaknesses"],
                ["Вопросы эксперту", "expertQuestions"],
              ].map(([title, key]) => (
                <tr key={key}>
                  <th>{title}</th>
                  {items.map((x) => (
                    <td key={x.project.id}>
                      {x.analysis ? (
                        Array.isArray((x.analysis as any)[key]) ? (
                          <ul>
                            {(x.analysis as any)[key].map(
                              (t: string, i: number) => (
                                <li key={i}>{t}</li>
                              ),
                            )}
                          </ul>
                        ) : (
                          (x.analysis as any)[key]
                        )
                      ) : (
                        "Анализ не завершён"
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th>Общая оценка</th>
                {items.map((x) => (
                  <td key={x.project.id}>
                    {x.analysis
                      ? `${x.analysis.commonTotal}/100${x.analysis.stale ? " · устарела" : ""}`
                      : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <th>Оценка по ТЗ</th>
                {items.map((x) => (
                  <td key={x.project.id}>
                    {x.analysis?.total == null
                      ? "—"
                      : `${x.analysis.total}/100 · ${x.track?.name || "Трек не определён"}`}
                  </td>
                ))}
              </tr>
              {method?.commonRubric.map((c) => (
                <tr key={c.id}>
                  <th>
                    {c.title} · до {c.max}
                  </th>
                  {items.map((x) => {
                    const score = x.analysis?.commonScores.find(
                      (s) => s.id === c.id,
                    );
                    return (
                      <td key={x.project.id}>
                        {score ? (
                          <>
                            <strong>
                              {score.points}/{c.max}
                            </strong>
                            <p>{score.rationale}</p>
                            <EvidenceLinks
                              items={score.evidence}
                              projectId={x.project.id}
                              snapshotId={x.analysis!.snapshotId}
                            />
                          </>
                        ) : (
                          "Анализ не завершён"
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {requirements.map((r) => (
                <tr key={`${r.hash}:${r.id}`}>
                  <th>
                    <small>
                      {r.trackName} ·{" "}
                      {r.kind === "optional"
                        ? "Дополнительно"
                        : r.kind === "constraint"
                          ? "Ограничение"
                          : "Обязательно"}
                    </small>
                    {r.text}
                  </th>
                  {items.map((x) => {
                    const finding =
                      x.analysis?.specHash === r.hash
                        ? x.analysis.findings.find(
                            (f) => f.requirementId === r.id,
                          )
                        : null;
                    return (
                      <td key={x.project.id}>
                        {finding ? (
                          <div className="comparison-finding">
                            <strong>{VERDICTS[finding.verdict]}</strong>
                            <p>{finding.explanation}</p>
                            <EvidenceLinks
                              items={finding.evidence}
                              projectId={x.project.id}
                              snapshotId={x.analysis!.snapshotId}
                            />
                          </div>
                        ) : x.analysis ? (
                          "Другой кейс или версия ТЗ"
                        ) : (
                          "Анализ не завершён"
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
type ChatReply = {
  answer: string;
  citations?: {
    projectId: number;
    path: string;
    start: number;
    quote: string;
    url: string;
  }[];
};
function Chat({ ids, stats }: { ids: number[]; stats: Stats | null }) {
  const [question, setQuestion] = useState(""),
    [messages, setMessages] = useState<{ role: string; reply: ChatReply }[]>(
      [],
    ),
    [job, setJob] = useState<number | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!job) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const j = await api<Job>(`/jobs/${job}`);
        if (!live) return;
        if (j.state === "done") {
          setMessages((s) => [
            ...s,
            { role: "assistant", reply: j.result as ChatReply },
          ]);
          setJob(null);
        }
        if (["failed", "cancelled"].includes(j.state)) {
          setError(j.error || "Запрос отменён");
          setJob(null);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }, 1800);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [job]);
  async function ask() {
    if (!question.trim() || job) return;
    setError("");
    try {
      const r = await api("/chat", { question, projectIds: ids });
      setMessages((s) => [...s, { role: "user", reply: { answer: question } }]);
      setQuestion("");
      setJob(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="eyebrow">ОТВЕТЫ С ИСТОЧНИКАМИ</div>
      <div className="page-heading">
        <div>
          <h1>AI-ассистент</h1>
          <p>
            {ids.length
              ? `Контекст: ${ids.length} выбранных проектов.`
              : "Задайте вопрос по названию проекта или выберите проекты в каталоге."}
          </p>
        </div>
        <MessageSquare size={30} strokeWidth={1.3} />
      </div>
      <div className="chat-area">
        {!messages.length && (
          <div className="chat-welcome">
            <span className="assistant-symbol">✳</span>
            <h2>Что хотите узнать о проектах?</h2>
            <p>
              Сравните подходы, найдите реализацию функции
              <br />
              или уточните ограничения выбранного решения.
            </p>
            <div className="suggestions">
              {[
                "Как устроен AI в Digital Yakuza?",
                "Какие ограничения у Halyk Career Quest?",
              ].map((q) => (
                <button key={q} onClick={() => setQuestion(q)}>
                  {q}
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-message ${m.role}`}>
            <div className="message-label">
              {m.role === "user" ? "Вы" : "HackAlem AI"}
            </div>
            <Markdown text={m.reply.answer} />
            {m.reply.citations?.map((c, j) => (
              <Link key={j} to={c.url} className="chat-citation">
                [{j + 1}] {c.path}:{c.start}
                <ArrowUpRight size={12} />
              </Link>
            ))}
          </div>
        ))}
        {job && (
          <div className="loading">
            <Loader2 size={17} className="spin" />
            {stats?.paused
              ? "Очередь на паузе. Продолжите её в настройках."
              : "Запрос в очереди. Ответ появится после обработки."}
          </div>
        )}
      </div>
      <ErrorBox message={error} />
      <div className="chat-composer">
        <textarea
          aria-label="Вопрос ассистенту"
          placeholder="Спросите о проектах…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <button
          className="button primary"
          aria-label="Отправить вопрос"
          disabled={!!job || !question.trim()}
          onClick={ask}
        >
          <Send size={18} />
        </button>
      </div>
      <p className="muted small-text">
        Ответы ограничены найденными источниками. AI не выполняет код и не
        подтверждает результаты запуска.
      </p>
    </>
  );
}
function Methodology({ tracks }: { tracks: Track[] }) {
  const { data } = useApi<{
    version: string;
    commonRubric: { id: string; title: string; max: number }[];
    policy: string;
  }>("/methodology");
  return (
    <>
      <div className="eyebrow">ПРОЗРАЧНОСТЬ ОЦЕНКИ</div>
      <div className="page-heading">
        <div>
          <h1>Методика и источники</h1>
          <p>Все выводы привязаны к снимку репозитория и версии задания.</p>
        </div>
      </div>
      <div className="notice">
        12 треков в предоставленных материалах, 10 задач в положении. Спецтреки
        сохранены; принадлежность к основному призовому зачёту не
        предполагается.
      </div>
      <h2>Как устроена оценка</h2>
      <p className="body-text">
        Сначала читаются исходники и README, затем проверяются требования кейса.
        Баллы по ТЗ и общий аналитический рейтинг хранятся отдельно. Фактическая
        работоспособность, скрытые тесты и выступление на Demo Day требуют
        проверки человеком.
      </p>
      <div className="rubric-strip">
        {data?.commonRubric.map((r) => (
          <div key={r.id}>
            <strong>{r.max}</strong>
            <span>{r.title}</span>
          </div>
        ))}
      </div>
      <h2>Технические задания</h2>
      <div className="source-list">
        {tracks.map((t) => (
          <details key={t.id}>
            <summary>
              <span className="track-number">
                {String(t.id).padStart(2, "0")}
              </span>
              <strong>{t.name}</strong>
              <span>{t.caseName}</span>
            </summary>
            <TrackSource id={t.id} />
          </details>
        ))}
      </div>
      {data && (
        <>
          <h2>Основания и границы использования</h2>
          <Markdown text={data.policy} />
          <small className="muted">Версия методики: {data.version}</small>
        </>
      )}
    </>
  );
}
function TrackSource({ id }: { id: number }) {
  const { data } = useApi<Track>(`/tracks/${id}`);
  return data ? (
    <div className="track-source">
      <a href={data.url} className="text-link" target="_blank" rel="noreferrer">
        Google Документ
        <ArrowUpRight size={14} />
      </a>
      <p className="muted">
        {data.rubricOrigin === "analytical"
          ? "Аналитические веса: в ТЗ балльная шкала отсутствует."
          : "Шкала из технического задания."}
      </p>
      <pre>{data.spec}</pre>
    </div>
  ) : (
    <Loading />
  );
}
function Settings({
  stats,
  revision,
  refresh,
}: {
  stats: Stats | null;
  revision: number;
  refresh: () => void;
}) {
  const { data: harnesses, error } = useApi<{
    items: HarnessInfo[];
    selected: string;
    model: string;
  }>("/harnesses", revision);
  const [harness, setHarness] = useState("codex"),
    [model, setModel] = useState(""),
    [notice, setNotice] = useState(""),
    [filter, setFilter] = useState("");
  const { data: jobs } = useApi<Job[]>(
    "/jobs" + (filter ? "?state=" + filter : ""),
    `${stats?.workerHeartbeat}:${revision}`,
  );
  useEffect(() => {
    if (harnesses) {
      setHarness(harnesses.selected);
      setModel(harnesses.model);
    }
  }, [harnesses]);
  async function act(path: string, body: unknown = {}, method = "POST") {
    try {
      await api(path, body, method);
      setNotice("Сохранено");
      refresh();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  const workerLive =
    stats?.workerHeartbeat &&
    Date.now() - new Date(stats.workerHeartbeat).getTime() < 15000;
  return (
    <>
      <div className="eyebrow">УПРАВЛЕНИЕ ОБРАБОТКОЙ</div>
      <div className="page-heading">
        <div>
          <h1>Обработка и настройки</h1>
          <p>Загрузка источников и AI-анализ выполняются в фоновой очереди.</p>
        </div>
        <button
          className="button"
          onClick={() => act("/queue", { paused: !stats?.paused })}
        >
          {stats?.paused ? <Play size={16} /> : <Pause size={16} />}{" "}
          {stats?.paused ? "Продолжить" : "Приостановить"}
        </button>
      </div>
      <ErrorBox message={error} />
      {notice && <div className="notice">{notice}</div>}
      {stats?.paused && <div className="notice amber">{stats.pauseReason}</div>}
      {!workerLive && (
        <ErrorBox message="Процесс обработки не запущен. Выполните npm start или npm run worker в папке проекта." />
      )}
      <div className="settings-grid">
        <section>
          <h2>Модели по подписке</h2>
          <p className="muted">
            Используется вход в локальные CLI. Перехода на платный API нет.
          </p>
          <div className="harness-list">
            {harnesses?.items.map((h) => (
              <label
                key={h.id}
                className={`harness ${harness === h.id ? "chosen" : ""}`}
              >
                <input
                  type="radio"
                  name="harness"
                  value={h.id}
                  checked={harness === h.id}
                  onChange={() => setHarness(h.id)}
                />
                <div>
                  <strong>
                    {h.id === "codex" ? "OpenAI Codex" : "Claude Code"}
                  </strong>
                  <small>{h.version || "Не установлен"}</small>
                </div>
                <span className={`badge ${h.ready ? "green" : "amber"}`}>
                  {h.ready ? "Подключён" : "Требует настройки"}
                </span>
                <p>{h.note}</p>
              </label>
            ))}
          </div>
          <label className="field-label">
            Модель
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="По умолчанию CLI"
            />
          </label>
          <div className="button-group">
            <button
              className="button primary"
              onClick={() => act("/harnesses", { harness, model }, "PATCH")}
            >
              Сохранить
            </button>
            <button
              className="button"
              onClick={async () => {
                try {
                  await api("/harnesses?refresh=1");
                  refresh();
                } catch (e) {
                  setNotice((e as Error).message);
                }
              }}
            >
              <RefreshCw size={14} />
              Проверить подключение
            </button>
          </div>
        </section>
        <aside className="inspector">
          <h3>Состояние очереди</h3>
          <a className="text-link" href="/api/reports/coverage?format=md">
            Отчёт о покрытии
            <Download size={14} />
          </a>
          <div className="large-score">
            {fmt(stats?.queued || 0)}
            <small>заданий</small>
          </div>
          <p>
            <span className={`badge ${workerLive ? "green" : "amber"}`}>
              {workerLive ? "Worker работает" : "Worker остановлен"}
            </span>
          </p>
          <p>{stats?.running[0]?.progress || "Нет активного задания"}</p>
          <div className="divider" />
          <p>
            Задания выполняются последовательно. Результаты сохраняются после
            каждого этапа.
          </p>
          <p className="muted">
            Лимит подписки приостанавливает очередь. После восстановления квоты
            нажмите «Продолжить».
          </p>
        </aside>
      </div>
      <div className="section-heading">
        <h2>Последние задания</h2>
        <select
          aria-label="Состояние задания"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">Все состояния</option>
          <option value="failed">Ошибки</option>
          <option value="queued">В очереди</option>
          <option value="done">Готово</option>
        </select>
      </div>
      <div className="table-wrap">
        <table className="simple-table jobs-table">
          <thead>
            <tr>
              <th>ЗАДАНИЕ</th>
              <th>ПРОГРЕСС</th>
              <th>СОСТОЯНИЕ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs
              ?.filter((j) => !filter || j.state === filter)
              .map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>
                      {
                        {
                          sync: "Импорт GitHub",
                          snapshot: "Загрузка снимка",
                          analyze: "AI-анализ",
                          chat: "Вопрос ассистенту",
                        }[j.type]
                      }
                    </strong>
                    <small>
                      #{j.id} · {date(j.updatedAt)}
                      {j.projectId && (
                        <>
                          {" "}
                          ·{" "}
                          <Link to={`/project/${j.projectId}`}>Проект ↗</Link>
                        </>
                      )}
                    </small>
                  </td>
                  <td>
                    {j.error ? (
                      <span className="error-text">{j.error}</span>
                    ) : (
                      j.progress || "Ожидание"
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${j.state === "done" ? "green" : j.state === "failed" ? "amber" : ""}`}
                    >
                      {
                        {
                          queued: "В очереди",
                          running: "В работе",
                          done: "Готово",
                          failed: "Ошибка",
                          cancelled: "Отменено",
                        }[j.state]
                      }
                    </span>
                  </td>
                  <td>
                    {["failed", "cancelled"].includes(j.state) ? (
                      <button
                        className="button small"
                        onClick={() => act(`/jobs/${j.id}/retry`)}
                      >
                        Повторить
                      </button>
                    ) : ["running", "queued"].includes(j.state) ? (
                      <button
                        className="icon-button"
                        aria-label="Отменить задание"
                        onClick={() => act(`/jobs/${j.id}/cancel`)}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

function SpecificationPage({ hash, line }: { hash: string; line: number }) {
  const { data, error } = useApi<Track>(
    `/specifications/${encodeURIComponent(hash)}`,
  );
  useEffect(() => {
    if (data)
      document
        .getElementById(`spec-line-${line}`)
        ?.scrollIntoView({ block: "center" });
  }, [data, line]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <Link className="back" to="/methodology">
        <ArrowLeft size={15} />
        Методика и источники
      </Link>
      <div className="page-heading">
        <div>
          <h1>{data.name}</h1>
          <p>{data.caseName}</p>
        </div>
        <a className="button" href={data.url} target="_blank" rel="noreferrer">
          Google Документ
          <ArrowUpRight size={16} />
        </a>
      </div>
      <p className="muted">Сохранённая версия ТЗ · {hash.slice(0, 12)}</p>
      <div className="source-viewer">
        <pre style={{ whiteSpace: "pre-wrap" }}>
          {data.spec.split(/\r?\n/).map((text, i) => (
            <div
              id={`spec-line-${i + 1}`}
              className={line === i + 1 ? "highlight" : ""}
              key={i}
            >
              <span>{i + 1}</span>
              <code>{text || " "}</code>
            </div>
          ))}
        </pre>
      </div>
    </>
  );
}
