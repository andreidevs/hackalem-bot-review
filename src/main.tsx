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
  Copy,
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
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { QUICK_RUBRIC, type QuickReview } from "../shared/types.js";
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
import { STATUS, VERDICTS, COMMON_RUBRIC, HACKALEM_RUBRIC, HACKALEM_MAX, README_CHECKLIST, type ReadmeChecklist } from "../shared/types";
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
  allProjects: number;
  activityHours: number | "hackathon";
  quickReviewed: number;
  analysisMode: "quick" | "full";
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
    [analysisMode, setAnalysisMode] = useState<"quick" | "full">("quick"),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => { if(stats?.analysisMode) setAnalysisMode(stats.analysisMode); },[stats?.analysisMode]);
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
    `${stats?.analyzed}:${stats?.quickReviewed}:${stats?.activityHours}:${revision}`,
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
      if (analysisMode === "quick") {
        await api("/quick/start", {});
        setToast("Быстрый анализ README запущен. Полный анализ кода отложен; результаты сохраняются по пакетам.");
        refresh();
        navigate("/quick");
        return;
      }
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
    ["/quick", "Быстрый отбор", FileText],
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
              title={analysisMode === "quick" ? "Только README: определить треки и оценить перспективность описаний" : "Полный анализ исходного кода всех проектов без актуальной оценки"}
            >
              {startingAll ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Play size={15} />
              )}
              {startingAll ? "Запускаем…" : analysisMode === "quick" ? "Быстрый анализ всех" : "Полный анализ всех"}
            </button>
            <select className="mode-select" aria-label="Режим анализа" value={analysisMode} onChange={e=>setAnalysisMode(e.target.value as "quick" | "full")}>
              <option value="quick">Быстрый · README</option>
              <option value="full">Полный · исходный код</option>
            </select>
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
          ) : path === "/quick" ? (
            <QuickRankingPage tracks={tracks || []} stats={stats} params={params} revision={revision} />
          ) : path.startsWith("/readme/") ? (
            <ReadmeSourcePage id={Number(path.split("/")[2])} line={Number(params.get("line")) || 1} />
          ) : path.startsWith("/project/") ? (
            <ProjectPage
              id={Number(path.split("/")[2])}
              tracks={tracks || []}
              params={params}
              revision={`${revision}:${stats?.analyzed}:${stats?.quickReviewed}`}
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
              revision={`${stats?.analyzed}:${stats?.activityHours}`}
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
// Runs code analysis for every active project of a track and links to its ranking by score.
function TrackAnalysis({ track }: { track: Track }) {
  const [notice, setNotice] = useState("");
  const all = track.count || 0,
    done = track.analyzed || 0;
  return (
    <div className="track-analysis">
      <div className="button-group">
        <button
          className="button primary"
          disabled={!all || done >= all}
          onClick={async () => {
            if (
              !confirm(
                `Проверить код всех ${all} проектов трека «${track.name}»? Уже проверенные (${done}) не повторяются. Облегчённый режим: до 2 частей кода на проект.`,
              )
            )
              return;
            try {
              const r = await api<{ total: number; added: number }>(`/tracks/${track.id}/analyze`, {});
              setNotice(`В очереди на проверку кода: ${r.added} из ${r.total}`);
            } catch (e) {
              setNotice((e as Error).message);
            }
          }}
        >
          <Play size={15} /> Полный анализ трека
        </button>
        <Link className="button" to={`/rankings?track=${track.id}`}>
          <BarChart3 size={15} /> Рейтинг трека
        </Link>
      </div>
      <small className="muted">
        Код проверен: {done} из {all}
        {notice && ` · ${notice}`}
      </small>
    </div>
  );
}
// Global activity window: projects without a recent push are hidden and not processed.
function ActivityFilter({ stats }: { stats: Stats | null }) {
  const [value, setValue] = useState<number | "hackathon" | null>(null);
  const hours = value ?? stats?.activityHours ?? 0;
  const hidden = stats ? stats.allProjects - stats.total : 0;
  return (
    <label className="activity-filter">
      <select
        aria-label="Последний коммит"
        value={hours}
        onChange={async (e) => {
          const next = e.target.value === "hackathon" ? "hackathon" : Number(e.target.value);
          setValue(next);
          try {
            await api("/settings/activity", { hours: next }, "PATCH");
          } finally {
            setTimeout(() => setValue(null), 3000);
          }
        }}
      >
        <option value={0}>Все проекты</option>
        <option value="hackathon">Коммиты во время хакатона (23.09, 13–18)</option>
        <option value={24}>Коммит за последние 24 ч</option>
        <option value={48}>Коммит за последние 48 ч</option>
      </select>
      {hours !== 0 && hidden > 0 && (
        <small className="muted">Скрыто неактивных: {hidden}</small>
      )}
    </label>
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
    `${revision}:${stats?.total}:${stats?.snapshots}:${stats?.analyzed}:${stats?.quickReviewed}`,
  );
  const [copied, setCopied] = useState("");
  // Copies the repository links of every project under the current filters, not only this page.
  async function copyLinks() {
    try {
      const next = new URLSearchParams(params);
      next.delete("page");
      const res = await fetch("/api/projects/links?" + next);
      if (!res.ok) throw new Error(`Ошибка ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopied(`Скопировано ссылок: ${text ? text.split("\n").length : 0}`);
    } catch (e) {
      setCopied(`Не удалось скопировать: ${(e as Error).message}`);
    }
  }
  const track = tracks.find((t) => t.id === Number(params.get("track")));
  const sort = (params.get("sort") || "name") as "name" | "score" | "hackalem" | "quick";
  // The score column shows the value the list is sorted by.
  const shown = (p: Project): [number | null | undefined, number] =>
    sort === "hackalem"
      ? [p.hackalemTotal, HACKALEM_MAX]
      : sort === "quick"
        ? [p.quickTotal, 100]
        : [p.stale ? null : (p.total ?? p.commonTotal), 100];
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
        {track ? (
          <TrackAnalysis track={track} />
        ) : (
          <a
            className="text-link"
            href="https://github.com/BAITC-Hacks"
            target="_blank"
            rel="noreferrer"
          >
            Организация на GitHub
            <ArrowUpRight size={16} />
          </a>
        )}
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
          <span>Полный анализ кода</span>
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
                : stats?.running.length
                  ? stats.running[0].type === "quick" ? "Быстрый анализ README" : "Очередь обрабатывается"
                  : "Готов к работе"}
            <Link to="/settings">
              <ArrowRight size={14} />
            </Link>
          </small>
        </div>
      </div>
      <div className="mode-overview">
        <Link to="/quick"><FileText size={21}/><div><strong>01 · Быстрый отбор по README</strong><p>Определение треков и перспективных идей. Оценено: {fmt(stats?.quickReviewed || 0)}.</p></div><ArrowRight size={17}/></Link>
        <Link to="/rankings"><Code2 size={21}/><div><strong>02 · Полная проверка кода</strong><p>Подтвердить заявления описания исходниками и доказательствами.</p></div><ArrowRight size={17}/></Link>
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
        <ActivityFilter stats={stats} />
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
        <select
          aria-label="Сортировка"
          value={sort}
          onChange={(e) => change("sort", e.target.value === "name" ? "" : e.target.value)}
        >
          <option value="name">По названию</option>
          <option value="score">По оценке кода</option>
          <option value="hackalem">По шкале HackAlem</option>
          <option value="quick">По оценке README</option>
        </select>
        <button
          className="button"
          title="Скопировать ссылки на репозитории всех проектов с текущими фильтрами (например, выбранного трека)"
          onClick={copyLinks}
        >
          <Copy size={15} /> Копировать ссылки
        </button>
        {copied && <span role="status" className="muted">{copied}</span>}
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
                <th className="score-col">
                  <button
                    className="sort-header"
                    title="Сортировать по оценке кода"
                    onClick={() => change("sort", sort === "score" ? "" : "score")}
                  >
                    {sort === "hackalem" ? "HACKALEM" : sort === "quick" ? "README" : "ОЦЕНКА"}
                    {sort !== "name" ? " ↓" : ""}
                  </button>
                </th>
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
                    {shown(p)[0] != null ? (
                      <span className="score">
                        {shown(p)[0]}
                        <small>/{shown(p)[1]}</small>
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
function QuickRankingPage({tracks,stats,params,revision}:{tracks:Track[];stats:Stats|null;params:URLSearchParams;revision:number}) {
  const [chosen,setChosen] = useState<number[]>([]), [notice,setNotice] = useState(""), [busy,setBusy] = useState(false);
  const {data,error} = useApi<{items:QuickReview[];total:number;page:number;limit:number;reviewed:number;stale:number;statuses:{status:string;count:number}[]}>(`/quick/rankings?${params}`,`${revision}:${stats?.quickReviewed}:${stats?.activityHours}:${stats?.running[0]?.progress}`);
  function change(key:string,value:string) { const next = new URLSearchParams(params); value ? next.set(key,value) : next.delete(key); if(key!=="page")next.delete("page");navigate(`/quick?${next}`); }
  async function run(full:boolean) {
    setBusy(true);setNotice("");
    try {
      if(full) {
        await api("/jobs/analyze-selected",{ids:chosen});
        setNotice(`Полная проверка выбранных проектов (${chosen.length}) запущена. Прогресс — в «Обработка и настройки».`);
      } else {
        await api("/quick/start",{});
        setNotice("Быстрый отбор запущен. Готовые оценки используются повторно; полный анализ отложен.");
      }
    } catch(e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  const job = stats?.running.find(j=>j.type==="quick");
  return <>
    <div className="eyebrow">ЭТАП 01 · ТОЛЬКО ОПИСАНИЕ</div>
    <div className="page-heading"><div><h1>Быстрый отбор</h1><p>Найдите перспективные идеи по README, затем проверьте их исходный код.</p></div><button className="button primary" disabled={busy || !stats?.total} onClick={()=>run(false)}><Play size={15}/>Оценить все README</button></div>
    <div className="notice">Предварительный рейтинг описаний, а не качества кода. Треки определяются автоматически; неоднозначные случаи требуют классификации. До 6 000 символов README на проект, до 12 проектов в запросе. Исходники и команды проектов не запускаются.</div>
    <div className="quick-progress"><strong>{fmt(data?.reviewed || 0)} / {fmt(stats?.total || 0)} README оценено</strong><span>{job?.progress || (stats?.paused ? stats.pauseReason : "Результаты сохраняются после каждого пакета")}</span></div>
    {!!data?.statuses.length && <p className="muted">{data.statuses.filter(s=>s.status!=="ready").map(s=>`${({missing:"Нет README",template:"Шаблонный README без описания",empty:"Пустые",too_large:"README превышает лимит",error:"Ошибки загрузки"} as Record<string,string>)[s.status] || s.status}: ${s.count}`).join(" · ")}{data.stale ? ` · Устаревшие: ${data.stale}` : ""}. Без доступного README баллы не назначаются.</p>}
    <div className="filters"><ActivityFilter stats={stats} /><input aria-label="Поиск в быстром рейтинге" placeholder="Команда или идея…" value={params.get("q") || ""} onChange={e=>change("q",e.target.value)}/><select aria-label="Трек быстрого рейтинга" value={params.get("track") || ""} onChange={e=>change("track",e.target.value)}><option value="">Все 12 треков</option>{tracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><Link to="/rankings" className="text-link">Рейтинг по исходному коду <ArrowRight size={14}/></Link></div>
    <div className="quick-actions"><button className="button" disabled={!data?.items.length} onClick={()=>setChosen(data!.items.slice(0,10).map(r=>r.projectId))}>Выбрать первые 10 на странице</button><button className="text-button" onClick={()=>setChosen([])}>Сбросить</button><button className="button primary" disabled={!chosen.length || busy} onClick={()=>run(true)}><Code2 size={15}/>Проверить код выбранных ({chosen.length})</button></div>
    {notice && <div role="status" className="notice">{notice}</div>}<ErrorBox message={error}/>
    {!data ? <Loading/> : !data.items.length ? <Empty title="Здесь появится отбор по README" detail="Запустите быстрый анализ. Результаты и треки будут появляться по мере обработки пакетов." icon={FileText}/> : <div className="quick-list">{data.items.map(r=><article className="quick-row" key={r.id}><input type="checkbox" aria-label={`Проверить код ${r.team}`} checked={chosen.includes(r.projectId)} disabled={chosen.length>=50 && !chosen.includes(r.projectId)} onChange={()=>setChosen(a=>a.includes(r.projectId)?a.filter(id=>id!==r.projectId):[...a,r.projectId])}/><span className="rank">{r.rank}</span><div><Link to={`/project/${r.projectId}?tab=quick`}><h3>{r.team}</h3></Link><p>{r.summary}</p><span className="badge">{tracks.find(t=>t.id===r.trackId)?.name || "Требует классификации"}</span> <ChecklistBadge checklist={r.readmeChecklist}/>{r.trackMismatch && <span className="badge amber" title="В README назван другой кейс; трек стоит проверить">В README: {tracks.find(t=>t.id===r.declaredTrackId)?.name}</span>}{!r.trackId && r.candidates.length>0 && <small> Возможные треки: {r.candidates.map(id=>tracks.find(t=>t.id===id)?.name).join(", ")}</small>}<p className="muted">{r.risks[0]}</p><Link className="text-link" to={`/readme/${r.sourceId}`}>README · {r.sha.slice(0,8)} <ArrowUpRight size={13}/></Link></div><div className="ranking-score">{r.total}<small>/100 · описание</small></div></article>)}</div>}
    {data && data.total>40 && <div className="pagination"><button className="button" disabled={data.page<=1} onClick={()=>change("page",String(data.page-1))}>Назад</button><span>{data.page} / {Math.ceil(data.total/40)}</span><button className="button" disabled={data.page*40>=data.total} onClick={()=>change("page",String(data.page+1))}>Далее</button></div>}
  </>;
}
function QuickAssessment({review:r,tracks}:{review:QuickReview;tracks:Track[]}) {
  return <>
    <div className="notice">Быстрый анализ README · код не изучался · {r.total}/100 за описание{r.stale && <strong>Оценка устарела</strong>}</div>
    <h2>{tracks.find(t=>t.id===r.trackId)?.name || "Требует классификации"}</h2>
    {r.trackMismatch && <p className="notice amber">В README назван кейс «{tracks.find(t=>t.id===r.declaredTrackId)?.name}», а модель выбрала другой трек. Проверьте трек вручную.</p>}
    {!r.trackId && <p>Возможные треки: {r.candidates.map(id=>tracks.find(t=>t.id===id)?.name).join(", ") || "Недостаточно данных"}</p>}
    <p>{r.summary}</p><div className="two-columns"><section><h3>Почему стоит проверить</h3><ul>{r.strengths.map((s,i)=><li key={i}>{s}</li>)}</ul></section><section><h3>Что проверить по коду</h3><ul>{r.risks.map((s,i)=><li key={i}>{s}</li>)}</ul></section></div>
    <div className="score-list">{r.scores.map(s=><section key={s.id}><h3>{QUICK_RUBRIC.find(c=>c.id===s.id)?.title} · {s.points}/{QUICK_RUBRIC.find(c=>c.id===s.id)?.max}</h3><p>{s.rationale}</p><div className="evidence-links">{s.evidence.map((e,i)=><Link key={i} to={`/readme/${r.sourceId}?line=${e.start}`} title={e.quote}>{e.path}:{e.start}–{e.end}</Link>)}</div></section>)}</div>
    <p className="muted">{r.model} · {date(r.createdAt)} · {r.methodVersion} · прочитано {fmt(r.reviewedChars)} символов{r.truncated ? " · README усечён" : " · README целиком"}. SHA {r.sha}.</p>
  </>;
}
function ReadmeSourcePage({id,line}:{id:number;line:number}) {
  const {data,error} = useApi<{path:string|null;sha:string;text:string;project_id:number;status:string}>(`/readmes/${id}`);
  const highlight = useRef<HTMLDivElement>(null);
  useEffect(()=>{highlight.current?.scrollIntoView({block:"center"});},[data,line]);
  if(error)return <ErrorBox message={error}/>;
  if(!data)return <Loading/>;
  return <><Link className="back" to={`/project/${data.project_id}?tab=quick`}><ArrowLeft size={14}/>К быстрой оценке проекта</Link><h1>{data.path || "README"}</h1><p className="muted">Сохранённый источник · SHA {data.sha}</p><div className="readme-lines">{data.text.split("\n").map((text,i)=><div key={i} ref={i+1===line ? highlight : undefined} className={i+1===line ? "highlight" : ""}><span>{i+1}</span><code>{text || " "}</code></div>)}</div></>;
}
type Detail = {
  demoUrls: string[];
  project: Project;
  snapshot:
    | (Omit<Snapshot, "files"> & { files: Omit<SourceFile, "text">[] })
    | null;
  analysis: Analysis | null;
  quickReview: QuickReview | null;
  readmeSource: {id:number;path:string|null;text:string;sha:string;status:string;checklist:ReadmeChecklist|null} | null;
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
  const [tab, setTab] = useState(params.get("tab") || "overview"),
    [notice, setNotice] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    setTab(params.get("tab") || "overview");
    setNotice("");
  }, [id,params.get("tab")]);
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
      if(type === "quick") await api("/quick/start", {projectId:id});
      else await api("/jobs", { type, projectId: id });
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
        <CommitFlags stats={p.commitStats} />
        <ChecklistBadge checklist={data.readmeSource?.checklist} />
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
          className="button small"
          onClick={() => action("quick")}
        ><FileText size={13}/>Быстрый · README</button>
        <button
          className="button small primary"
          onClick={() => action("analyze")}
        >
          <Play size={13} />
          Полный · код
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
              ["quick", "Быстрая оценка"],
              ["assessment", "Полная оценка и доказательства"],
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
          {tab === "quick" && (data.quickReview ? <QuickAssessment review={data.quickReview} tracks={tracks}/> : <Empty title="Быстрой оценки пока нет" detail="Нажмите «Быстрый · README»: исходный код скачивать не требуется." icon={FileText}/>)}
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
                {(a?.candidates || data.quickReview?.candidates || []).length > 0 && (
                  <p className="muted">
                    Кандидаты:{" "}
                    {(a?.candidates || data.quickReview?.candidates || [])
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
            (s?.readme || data.readmeSource?.text ? (
              <>
                <ReadmeChecklistPanel checklist={data.readmeSource?.checklist} />
                <div className="source-caption">
                  <FileText size={15} />
                  {s?.readmePath || data.readmeSource?.path}
                  <span>{(s?.sha || data.readmeSource?.sha)?.slice(0, 8)}</span>
                </div>
                <Markdown
                  text={s?.readme || data.readmeSource!.text}
                  base={`${p.url}/blob/${s?.sha || data.readmeSource?.sha}/${s?.readmePath || data.readmeSource?.path}`}
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
      {!!a.coverage?.omitted && (
        <p className="muted">
          Проект крупный: {a.coverage.omitted} из {a.coverage.read} файлов не
          вошли в анализ (читались в первую очередь README, манифесты и код).
        </p>
      )}
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
      {a.hackalemScores && (
        <details open>
          <summary>
            Шкала HackAlem (критерии жюри, п. 5.7.2 Положения) · {a.hackalemTotal}/{HACKALEM_MAX}
          </summary>
          <p className="muted">
            «Презентация, демо и ответы на вопросы» (20 баллов) оценивается только на Demo Day,
            поэтому здесь максимум {HACKALEM_MAX}.
          </p>
          {a.hackalemScores.map((s) => (
            <div className="finding" key={s.id}>
              <h3>
                {HACKALEM_RUBRIC.find((c) => c.id === s.id)?.title || s.id}:{" "}
                {s.points}/{HACKALEM_RUBRIC.find((c) => c.id === s.id)?.max}
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
      )}
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
// README sections required for the technical check (п. 5.4.15); a keyword check, not a verdict.
function ChecklistBadge({ checklist }: { checklist?: ReadmeChecklist | null }) {
  if (!checklist) return null;
  const total = README_CHECKLIST.length;
  const missing = checklist.missing
    .map((id) => README_CHECKLIST.find((c) => c.id === id)?.title || id)
    .join(", ");
  return (
    <span
      className={`badge ${checklist.passed === total ? "green" : "amber"}`}
      title={
        checklist.passed === total
          ? "README содержит все разделы п. 5.4.15 (по ключевым словам)"
          : `Нет в README (п. 5.4.15): ${missing}`
      }
    >
      README {checklist.passed}/{total}
    </span>
  );
}
function ReadmeChecklistPanel({ checklist }: { checklist?: ReadmeChecklist | null }) {
  if (!checklist) return null;
  return (
    <div className="notice">
      <strong>README по п. 5.4.15 Положения: {checklist.passed}/{README_CHECKLIST.length}</strong>
      <ul className="checklist">
        {README_CHECKLIST.map((c) => (
          <li key={c.id} className={checklist.missing.includes(c.id) ? "missing" : "present"}>
            {checklist.missing.includes(c.id) ? "✗" : "✓"} {c.title}
          </li>
        ))}
      </ul>
      <small className="muted">
        Проверка по ключевым словам: показывает, есть ли раздел, но не его качество. Если проект не
        запускается по README, команда не допускается к отбору (п. 5.4.16).
      </small>
    </div>
  );
}
// Commit rhythm flags: signals for the expert to check, not points. Hours are 13–18 Astana.
function CommitFlags({ stats }: { stats: Project["commitStats"] }) {
  if (!stats) return null;
  const active = stats.hours.filter((n) => n > 0).length;
  const lastHour = stats.window ? stats.hours[4] / stats.window : 0;
  return (
    <span className="commit-flags">
      <span
        className="badge"
        title={`Коммиты по часам 13–18: ${stats.hours.join(" / ")}`}
      >
        {stats.window} коммитов · {active}/5 ч
      </span>
      {stats.before > 0 && (
        <span className="badge amber" title="Коммиты команды раньше 13:00 23.09. П. 5.4.5 Положения запрещает представлять продукт, готовый до начала соревновательной части; заготовки и свои библиотеки допустимы (п. 5.4.4.2) — проверьте, что именно было до старта">
          До старта: {stats.before}
        </span>
      )}
      {stats.after > 0 && (
        <span className="badge amber" title="Коммиты после 18:00 23.09, после окончания разработки">
          После 18:00: {stats.after}
        </span>
      )}
      {stats.window >= 5 && lastHour >= 0.8 && (
        <span className="badge amber" title="80%+ коммитов в последний час: стоит проверить, как шла работа">
          Почти всё в последний час
        </span>
      )}
    </span>
  );
}
type Ranked = Project & { score: number; rank: number };
function RankingRow({ p, tracks, max = 100 }: { p: Ranked; tracks: Track[]; max?: number }) {
  return (
    <Link to={`/project/${p.id}`} className="ranking-row">
      <span className="rank">{String(p.rank).padStart(2, "0")}</span>
      <div>
        <h3>{p.team}</h3>
        <p>{p.summary}</p>
        <small>
          {tracks.find((t) => t.id === p.trackId)?.name || "Трек не определён"}
        </small>{" "}
        <ChecklistBadge checklist={p.readmeChecklist} />{" "}
        <CommitFlags stats={p.commitStats} />
      </div>
      <span className="ranking-score">
        {p.score}
        <small>/{max}</small>
      </span>
      <ArrowUpRight size={18} />
    </Link>
  );
}
// Final view: overall top-50 on the common scale and top-3 per track on the track rubric.
function TopView({ tracks, revision }: { tracks: Track[]; revision: unknown }) {
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<{
    overall: Ranked[];
    byTrack: {
      trackId: number;
      name: string;
      items: Ranked[];
      ai?: { stale: boolean; model: string; createdAt: string; items: (Ranked & { reason: string })[] };
    }[];
    shortlist: { total: number; analyzed: number; maxParts: number };
  }>("/top", `${revision}:${tick}`);
  async function pick() {
    try {
      const r = await api<{ queued: boolean }>("/top/pick", {});
      setNotice(r.queued ? "AI сравнивает финалистов каждого трека; топы появятся по мере готовности." : "AI-выбор топа уже в очереди.");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function start() {
    if (
      !confirm(
        "Отобрать ~100 лучших по быстрой оценке (по 6 в каждом треке) и проверить их код в облегчённом режиме (до 2 частей кода на проект). Это займёт около 1–1,5 часа. Продолжить?",
      )
    )
      return;
    try {
      const r = await api<{ shortlisted: number; added: number }>("/shortlist", {});
      setNotice(`В шорт-листе ${r.shortlisted} проектов, анализ кода запущен.`);
      setTick((n) => n + 1);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  const s = data?.shortlist;
  return (
    <>
      <ErrorBox message={error} />
      {notice && <div className="notice">{notice}</div>}
      <div className="filters">
        <button className="button primary" onClick={start}>
          <Play size={15} /> Собрать шорт-лист и проверить код
        </button>
        <button
          className="button"
          title="Модель сравнивает до 10 лучших по баллам проектов трека между собой и выбирает топ-3"
          onClick={pick}
        >
          <BarChart3 size={15} /> AI-выбор топа по трекам
        </button>
        {!!s?.total && (
          <span className="muted">
            Код проверен: {s.analyzed} из {s.total} (до {s.maxParts} частей кода на проект)
          </span>
        )}
      </div>
      {!data ? (
        <Loading />
      ) : !data.overall.length ? (
        <Empty
          title="Топ ещё не сформирован"
          detail="Запустите шорт-лист после быстрого отбора: топ строится только по проверенному коду."
          icon={BarChart3}
        />
      ) : (
        <>
          <h2>Общий топ-{data.overall.length}</h2>
          <div className="ranking-list">
            {data.overall.map((p) => (
              <RankingRow key={p.id} p={p} tracks={tracks} />
            ))}
          </div>
          <h2>Топ-3 по трекам</h2>
          <p className="muted">AI-выбор сравнивает финалистов трека между собой; без него показан порядок по баллам.</p>
          {data.byTrack.map((t) => (
            <section key={t.trackId}>
              <h3>{t.name}</h3>
              {t.ai?.items.length ? (
                <>
                  <p className="muted">
                    AI-выбор из финалистов · {t.ai.model} · {date(t.ai.createdAt)}
                    {t.ai.stale && " · финалисты изменились, запустите выбор снова"}
                  </p>
                  <div className="ranking-list">
                    {t.ai.items.map((p) => (
                      <div key={p.id}>
                        <RankingRow p={p} tracks={tracks} />
                        <p className="muted">{p.reason}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : t.items.length ? (
                <div className="ranking-list">
                  {t.items.map((p) => (
                    <RankingRow key={p.id} p={p} tracks={tracks} />
                  ))}
                </div>
              ) : (
                <p className="muted">Пока нет проверенных проектов этого трека.</p>
              )}
            </section>
          ))}
        </>
      )}
    </>
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
  const hackalem = track === "hackalem";
  const { data, error } = useApi<(Project & { score: number; rank: number })[]>(
    track === "top"
      ? null
      : hackalem
        ? "/rankings?scale=hackalem"
        : "/rankings" + (track ? `?track=${track}` : ""),
    revision,
  );
  return (
    <>
      <div className="eyebrow">СРАВНИТЕЛЬНЫЙ АНАЛИЗ</div>
      <div className="page-heading">
        <div>
          <h1>Рейтинги проектов</h1>
          <p>
            {hackalem
              ? "Критерии жюри Demo Day из Положения (п. 5.7.2): ценность 25, результат 20, инновационность 15, потенциал 20. Презентация оценивается только на Demo Day."
              : track && track !== "top"
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
          <option value="top">Топ-50 и топ-3 по трекам</option>
          <option value="hackalem">Шкала HackAlem (критерии жюри, из 80)</option>
          <option value="">Общий аналитический рейтинг</option>
          {tracks.map((t) => (
            <option value={t.id} key={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {track !== "top" && (
          <span className="muted">{data?.length || 0} оценённых проектов</span>
        )}
      </div>
      <ErrorBox message={error} />
      {track === "top" ? (
        <TopView tracks={tracks} revision={revision} />
      ) : !data ? (
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
            <RankingRow key={p.id} p={p} tracks={tracks} max={hackalem ? HACKALEM_MAX : 100} />
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
type ModelOption = { id: string; label: string; description: string };
// Known models as a list; "Другая…" keeps a free-text escape hatch for new model names.
function ModelSelect({
  label,
  value,
  onChange,
  options,
  fallback,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ModelOption[];
  fallback: string;
}) {
  const [custom, setCustom] = useState(false);
  const isCustom = custom || (!!value && !options.some((m) => m.id === value));
  return (
    <label className="field-label">
      {label}
      <select
        value={isCustom ? "__custom" : value}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === "__custom");
          if (v !== "__custom") onChange(v);
        }}
      >
        <option value="">{fallback}</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.description ? ` — ${m.description}` : ""}
          </option>
        ))}
        <option value="__custom">Другая…</option>
      </select>
      {isCustom && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Идентификатор модели"
          autoFocus
        />
      )}
    </label>
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
    quickModel: string;
    concurrency: number;
    models: Record<string, ModelOption[]>;
  }>("/harnesses", revision);
  const [harness, setHarness] = useState("codex"),
    [model, setModel] = useState(""),
    [quickModel, setQuickModel] = useState(""),
    [concurrency, setConcurrency] = useState(3),
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
      setQuickModel(harnesses.quickModel);
      setConcurrency(harnesses.concurrency);
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
                  onChange={() => {
                    const ids = (harnesses?.models[h.id] || []).map((m) => m.id);
                    if (model && !ids.includes(model)) setModel("");
                    if (quickModel && !ids.includes(quickModel)) setQuickModel("");
                    setHarness(h.id);
                  }}
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
          <ModelSelect
            label="Модель полного анализа"
            value={model}
            onChange={setModel}
            options={harnesses?.models[harness] || []}
            fallback={
              harness === "codex"
                ? `По умолчанию CLI${harnesses?.items.find((h) => h.id === "codex")?.model ? ` (${harnesses.items.find((h) => h.id === "codex")!.model})` : ""}`
                : "По умолчанию CLI"
            }
          />
          <ModelSelect
            label="Модель быстрого отбора по README"
            value={quickModel}
            onChange={setQuickModel}
            options={harnesses?.models[harness] || []}
            fallback="Как у полного анализа"
          />
          <p className="muted">
            Смена модели быстрого отбора выводит прежние оценки из рейтинга: он
            строится одной моделью. Следующий быстрый отбор переоценит проекты.
          </p>
          <label className="field-label">
            Параллельных AI-вызовов
            <input
              type="number"
              min={1}
              max={8}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
            />
          </label>
          <div className="button-group">
            <button
              className="button primary"
              onClick={() =>
                act(
                  "/harnesses",
                  { harness, model, quickModel, concurrency },
                  "PATCH",
                )
              }
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
        <button
          className="button"
          disabled={!stats?.queued && !stats?.running.length}
          onClick={async () => {
            if (
              !confirm(
                `Удалить все задания из очереди (${stats?.queued ?? 0}) и остановить выполняемые (${stats?.running.length ?? 0})? Готовые анализы и снимки сохранятся.`,
              )
            )
              return;
            try {
              const r = await api<{ deleted: number; cancelled: number }>("/queue/clear", {});
              setNotice(`Удалено из очереди: ${r.deleted}, остановлено: ${r.cancelled}`);
              refresh();
            } catch (e) {
              setNotice((e as Error).message);
            }
          }}
        >
          <Trash2 size={16} /> Очистить очередь
        </button>
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
                          quick: "Быстрый README + треки",
                          chat: "Вопрос ассистенту",
                          final: "AI-выбор топа по трекам",
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
