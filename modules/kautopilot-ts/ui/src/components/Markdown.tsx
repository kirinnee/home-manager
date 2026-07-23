import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { Mermaid } from "./Mermaid";

// Rendered-prose markdown. Fenced ```mermaid blocks upgrade to inline SVG cards;
// code blocks get highlight.js classes. `allowHtml` enables rehype-raw so the
// diff redline's inline <ins>/<del> tags render (off by default — plain docs
// escape raw HTML).
export function Markdown({
	children,
	className,
	allowHtml = false,
}: {
	children: string;
	className?: string;
	allowHtml?: boolean;
}) {
	return (
		<div className={cn("prose", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={
					allowHtml ? [rehypeRaw, rehypeHighlight] : [rehypeHighlight]
				}
				components={{
					code({ className: cls, children: kids, ...props }) {
						const lang = /language-(\w+)/.exec(cls || "")?.[1];
						if (lang === "mermaid")
							return <Mermaid code={String(kids).replace(/\n$/, "")} />;
						return (
							<code className={cls} {...props}>
								{kids}
							</code>
						);
					},
					a({ href, children: kids, ...props }) {
						const external = /^https?:\/\//.test(href || "");
						return (
							<a
								href={href}
								{...(external
									? { target: "_blank", rel: "noopener noreferrer" }
									: {})}
								{...props}
							>
								{kids}
							</a>
						);
					},
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
