import type { Source } from "@/lib/types";

interface SourceListProps {
  sources: Source[];
}

export function SourceList({ sources }: SourceListProps) {
  if (sources.length === 0) return null;

  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {sources.map((source) => (
        <li key={source.url}>
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
