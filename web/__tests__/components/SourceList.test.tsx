import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceList } from "@/components/SourceList";
import type { Source } from "@/lib/types";

describe("SourceList", () => {
  it("renders nothing when sources array is empty", () => {
    const { container } = render(<SourceList sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a link for each source", () => {
    const sources: Source[] = [
      { title: "Caching", url: "https://nextjs.org/docs/caching", heading: "Overview" },
      { title: "Routing", url: "https://nextjs.org/docs/routing", heading: "Intro" },
    ];
    render(<SourceList sources={sources} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("Caching");
    expect(links[0]).toHaveAttribute("href", "https://nextjs.org/docs/caching");
    expect(links[1]).toHaveTextContent("Routing");
  });

  it("opens links in a new tab", () => {
    const sources: Source[] = [
      { title: "ISR", url: "https://nextjs.org/docs/isr", heading: "ISR" },
    ];
    render(<SourceList sources={sources} />);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
  });
});
