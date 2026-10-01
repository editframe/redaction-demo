import "./editframe";
import { TimelineRoot } from "@editframe/react";
import { createRoot } from "react-dom/client";
import { jobs } from "./jobs";
import { RedactedVideo } from "./redaction/RedactedVideo";

// One page per job (/jobs/<name>.html): the CLI appends its own query string to the URL, so the job is
// chosen by path, and flags are matched as substrings rather than parsed (a parsed "?nolabels?ef=1" would
// not find the flag). ?debug draws the tracks as outlines instead of redacting; ?nolabels prints plain blocks.
const name = location.pathname.split("/").pop()?.replace(/\.html$/, "") ?? "";
const flag = (f: string) => location.search.includes(f);
const plan = jobs[name];
if (!plan) throw new Error(`unknown job "${name}" (have: ${Object.keys(jobs).join(", ")})`);

const Job = ({ id }: { id: string }) => <RedactedVideo id={id} plan={plan} workbench debug={flag("debug")} labels={!flag("nolabels")} />;

createRoot(document.getElementById("root") as HTMLElement).render(<TimelineRoot id={name} component={Job} />);
