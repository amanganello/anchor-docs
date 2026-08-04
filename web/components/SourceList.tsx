import type { Source } from "@/lib/types";

interface SourceListProps {
  sources: Source[];
}

export function isAllowedCitationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "nextjs.org" || url.hostname.endsWith(".nextjs.org")) &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
    );
  } catch {
    return false;
  }
}

function citationKey(source: Source): string {
  return JSON.stringify([source.url, source.heading]);
}

export function SourceList({ sources }: SourceListProps) {
  const seen = new Set<string>();
  const allowedSources = sources.filter((source) => {
    if (!isAllowedCitationUrl(source.url)) return false;

    const key = citationKey(source);
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  if (allowedSources.length === 0) return null;

  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {allowedSources.map((source) => (
        <li key={citationKey(source)}>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded bg-white px-2 py-0.5 text-xs text-blue-700 ring-1 ring-blue-200 hover:ring-blue-400"
          >
            {source.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
