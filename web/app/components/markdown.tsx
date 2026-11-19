/**
 * Markdown léger pour les réponses des agents : blocs de code, titres, listes, gras, italique, code en ligne, liens.
 * Rendu en éléments React (jamais de HTML injecté) : le texte d'un agent ne peut pas insérer de balise.
 */
import type { ReactNode } from "react";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={k}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link)
      return (
        <a key={k} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return part;
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join("\n"), `p${blocks.length}`)}</p>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={`c${blocks.length}`} className="md-code">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushPara();
      blocks.push(
        <p key={`h${blocks.length}`} className="md-h">
          {inline(heading[2], `h${blocks.length}`)}
        </p>,
      );
      i++;
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push(m[2]);
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={`l${blocks.length}`} className="md-list">
          {items.map((t, j) => (
            <li key={j}>{inline(t, `l${blocks.length}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) flushPara();
    else para.push(line);
    i++;
  }
  flushPara();
  return <>{blocks}</>;
}
