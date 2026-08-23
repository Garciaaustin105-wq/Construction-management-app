"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import Card, { CardHeader } from "@/components/ui/Card";
import Button from "@/components/ui/Button";

// Renders an LLM result with a copy-to-clipboard action and an optional
// follow-up action slot (e.g. "Draft client update from this").
//
// TEXT RENDERING, not markdown: the repo has no markdown renderer and no
// react-markdown dependency, and the handoff only authorised adding
// @modelcontextprotocol/sdk. Pulling in a markdown pipeline for one panel would
// add a dependency AND an HTML-injection surface for model output. The AI
// summary is specified as plain text, so it is rendered as text with
// `whitespace-pre-wrap` (blank lines and "- " bullets survive) and light
// styling for lines that look like bullets. If Claude-direct decides the model
// should emit real markdown, swap ONLY the <Body> below.

function Body({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (
    <div className="text-sm text-gray-800 leading-relaxed space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed === "") return <div key={i} className="h-2" aria-hidden />;
        const bullet = /^[-*•]\s+/.test(trimmed);
        return (
          <p
            key={i}
            className={bullet ? "pl-4 -indent-2 whitespace-pre-wrap" : "whitespace-pre-wrap"}
          >
            {bullet ? `• ${trimmed.replace(/^[-*•]\s+/, "")}` : line}
          </p>
        );
      })}
    </div>
  );
}

export default function AiResultCard({
  title = "Summary",
  subtitle,
  text,
  actions,
}: {
  title?: string;
  subtitle?: string;
  /** The model's output. Rendered as text — never as HTML. */
  text: string;
  /** Extra buttons rendered beside Copy (e.g. "Draft client update"). */
  actions?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Revert the affordance so a second copy still reads as an action.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permission-gated (and unavailable on insecure origins).
      // Selecting the text by hand still works, so fail quietly rather than
      // throwing an error toast over a result the user can already read.
    }
  }

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex items-center gap-2">
            {actions}
            <Button type="button" variant="secondary" size="sm" onClick={copy}>
              {copied ? (
                <>
                  <Check className="w-4 h-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        }
      />
      <Body text={text} />
    </Card>
  );
}
