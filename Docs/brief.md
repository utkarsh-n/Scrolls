# Scrolls — product brief (from Utkarsh, 2026-10-03, verbatim except headings kept)

**His framing:** "I want to build an app that is basically a 4D gantt chart you can infinitely scroll
to see the evolution of linguistics, specifically regarding the data we have in our rap lyrics app
[Cipher]. … I want the initial iteration of this app to rely on our corpus of data we have for the
Cipher app. But I also want to include more data from science, technology, engineering,
mathematics, and medicine. All these fields have linguistic structures that have evolved and
contributed to the modern linguistic corpus."

## Original prompt (his)
Build a working application called Scrolls — A Living Atlas of Meaning.
You are the lead product designer, engineer, and computational linguistics collaborator. Implement the application through to a usable, verified result. Make reasonable decisions, inspect the existing environment, and continue without asking me to approve routine choices.
I have text libraries and datasets ready to supply. Build around real corpus ingestion, with a clearly labeled demonstration corpus so the app works immediately.

### 1. The idea
Create a visual, interactive observatory of how linguistic meaning and cultural interpretation evolve over time.
A word, phrase, quotation, symbol, or narrative motif enters culture in a particular context. Different people encounter it with different histories and associations. Later speakers and artists reuse it, sometimes preserving its meaning, sometimes reversing it, sometimes adding a new layer.
Over time: Expressions accumulate associations. Meanings diverge across communities. Quotations become slogans, jokes, clichés, or sincere declarations again. Later works change how audiences interpret earlier works. Complex ideas become reusable primitives for subsequent ideas. Disagreements over an expression become part of its cultural inheritance.
Represent this as a living system of transmission, transformation, branching, convergence, and feedback.
The central question is: "What did this expression mean here, to whom, at this time—and how did that meaning become material for what followed?"
The app should help users explore evidence and develop interpretations. Preserve a clear distinction between observed corpus patterns, computational estimates, and human annotations.

### 2. The primary experience
The main screen is a living semantic timeline. A user searches for a word, phrase, concept, or uploaded passage. The application displays its documented occurrences and evolving contexts across time.
The user can: 1. Scrub through time. 2. See contextual clusters emerge, grow, split, converge, or disappear. 3. Select a cluster and read the source passages behind it. 4. Trace a quotation or reference through successive works. 5. Compare periods, communities, genres, languages, or datasets. 6. Annotate an interpretation or correct an inferred relationship. 7. Save and share a reproducible view.
Make the experience understandable within the first minute.

### 3. Main views
A. Living timeline — Use time on the horizontal axis and configurable semantic lanes vertically. Lanes may represent contextual clusters, genres, communities, sources, or languages. Do not imply that the vertical position is a universal scale of meaning. Show: individual occurrences at close zoom; aggregated clusters at distant zoom; branches for distinguishable contextual uses; connections for documented or inferred relationships; frequency, contextual variety, and available evidence. Provide play/pause, scrubbing, date-range selection, zoom, filters, and a reduced-motion option. Animation should help explain change. It must not invent continuity across gaps in the corpus.
B. Meaning constellation — Display a network of expressions, contextual clusters, source works, and motifs for a selected period. Use node size and edge appearance only for explicitly named quantities. Include a persistent legend. Clicking a node opens its supporting passages. Clicking an edge explains the relationship and its provenance. Support a comparison between two periods. Keep the spatial layout stable enough that movement can be interpreted; arbitrary layout changes must not look like semantic change.
C. Lineage explorer — Show the "chain of custody" of an expression or reference. Relationship types: exact quotation, near quotation, explicit citation, adaptation, parody, recontextualization, proposed allusion, similar contextual usage. Keep these distinct. Every relationship needs supporting passages, a method or annotator, and an evidence status. Similarity alone must not establish influence, ancestry, or authorial intent. Allow disputed and competing lineage hypotheses.
D. Then / Now / Next inspector — Selecting a passage opens three interpretive layers: Then (documented historical setting and contemporary uses), Now (how a selected later passage reuses or reframes it), Next (subsequent documented uses, or an explicitly labeled user hypothesis about future reinterpretation). Make temporal layering visible without pretending to reconstruct a person's private thoughts.
E. Compare meanings — Compare two periods or corpus slices side by side: representative passages, common neighboring terms, relative frequency, contextual clusters and their distributions, new and declining uses, estimated semantic displacement when the analysis supports it, changes in tone or stance with uncertainty. Explain how differences in source coverage could affect the comparison.
F. Interpretation notebook — Attach notes to passages, clusters, edges, and saved views. Support multiple interpretations, supporting and contradicting evidence, tags and custom dimensions, revision history, human confirmation or rejection of inferred relationships. A new interpretation must preserve an older interpretation as a historically meaningful layer.

### 4. Conceptual model
Meaning in context = expression + surrounding language + historical setting + interpretive perspective.
Occurrence coordinates: expression or sensory reference; document time; context; affect or stance; significance or interpretation. This is a multidimensional analytical model — not proof that memory literally has five dimensions.
"Meaning" may contain: lexical sense, topic, referential target, pragmatic function, emotional tone, social or cultural association, an individual interpretation. Keep these categories inspectable. Topic change, sentiment change, and word-sense change are related possibilities, not interchangeable measurements.
Optional recursive culture view: how an expression becomes a reusable unit inside a later expression (story → metaphor → slogan → joke → sincere use).

### 5. Corpus ingestion
Inspect available files/integrations; never claim access to datasets not present. Support TXT, Markdown, CSV, JSON, JSONL (others only if cheap). Field-mapping interface for structured imports. Metadata: document ID, title, author/speaker, creation/publication date, date precision and uncertainty, language, genre/medium, community/source, collection, source URL/file reference, citation relationships, license/usage notes. Preserve original text and metadata; store normalized text separately. Handle missing/ambiguous dates, duplicates, malformed rows, mixed languages, uneven coverage. Keep undated material accessible outside chronological claims. Import summary: accepted, warnings, rejected, mapping decisions. Distinguish publication time, referenced historical time, ingestion time.

### 6. Analysis pipeline (interchangeable stages)
1 parse+validate 2 preserve originals 3 normalize+segment 4 search indexes + contextual windows 5 occurrences + collocations 6 exact/approximate quotation detection 7 contextual representations when a model is available 8 group contexts within time windows 9 compare contextual distributions across periods 10 visual summaries with inspectable evidence.
v1: lexical search, contextual windows, collocations, quotation detection, temporal aggregation work without paid APIs. Optional adapters for embeddings / LM analysis; credentials never required.
Constraints: contextual occurrences for polysemy; adequate observations before reporting drift; show sample sizes and coverage; normalize frequency against the relevant slice; account for genre/source composition; no direct comparison of independently trained embedding spaces without alignment; label projection axes; machine cluster names editable; preserve model/parameter/pipeline versions; sentiment/stance = fallible annotations; never fabricate passages or citations. If rigorous analysis is unavailable, show evidence honestly and disable unsupported metrics.

### 7. Data model
Durable entities: corpus & collection; document & metadata; passage with offsets into original text; expression & normalized variants; occurrence; contextual cluster / sense hypothesis; time window; relationship; annotation; analysis run; saved view. Relationships record source & target, type, supporting passage IDs, evidence status, detection method or human annotator, confidence where meaningful, creation & revision history. No universal "meaning score". Saved view preserves filters, time range, selected items, analysis version, annotations — enough to reproduce the display.

### 8. Visual direction
Polished dark observatory: deep charcoal backgrounds, warm ivory text, cyan = selection & navigation, amber = historical references, violet = reinterpretation, restrained animation, clear typography, readable source passages. Timeline is the visual center. Progressive controls. Excellent empty/loading/error/low-evidence states. Keyboard navigation, accessible contrast, touch, reduced motion. Small screens: prioritize timeline + passage inspector. No decorative networks without useful interactions.

### 9. Demonstration corpus
Small, clearly labeled SYNTHETIC corpus spanning generations demonstrating: sincere→ironic; ironic→reclaimed sincerely; a symbol changing across communities; a remembered reference gaining new context; a term splitting into multiple uses; two expressions converging on a shared idea; a disagreement becoming part of a phrase's later meaning. Label invented passages, dates, authors, lineage as synthetic everywhere. Guided example: watch an expression acquire history, open the evidence, compare two interpretations.

### 10. Engineering
Reuse an existing stack if appropriate. Responsive frontend; reliable ingestion+analysis service; persistent storage; efficient text search; background processing; visualization layer for timelines+networks. Analysis independent from presentation. Expensive work cancellable with progress. Large corpora: aggregation, virtualization, caching, bounded graph expansion — never load every passage/node into the browser. Uploaded text local by default; external processing only by explicit understandable user choice. Real persistence, functional controls, useful exports (machine-readable filtered results + annotations; shareable visual snapshot).

### 11. Delivery order
Vertical slice first: import corpus → search expression → explore timeline → open source evidence → compare periods → save view. Then: 1 quotation lineage 2 contextual clustering 3 constellation 4 notebook 5 optional advanced analysis. Coherent working core over unfinished screens.

### 12. Acceptance criteria
Real uploaded corpus imports and is searchable · dates and unknown dates behave correctly · every displayed occurrence opens its original passage · filters update visualizations and counts consistently · demo material clearly labeled · inferred lineage cannot be mistaken for documented citation · insufficient evidence never yields authoritative drift claims · saved views + annotations survive restart · malformed input gives actionable feedback · main flow works desktop + narrow viewport · expensive analysis does not freeze the UI. Meaningful tests for ingestion, offsets, temporal aggregation, relationship provenance, persistence. Inspect the rendered interface and exercise the main journey.

### 13. Handoff
Running app, source, setup instructions, supported import schema, concise explanation of analysis + limits. State exactly what works, what needs an optional model/service, what is unfinished.
Guiding principle: *An expression carries its past into each new encounter. Let the user see what survives, what changes, and what evidence connects the two.*

---
## Platform decision (Utkarsh, 2026-10-09)
"You realize this is supposed to be a native SwiftUI app right?" — the first build was a local web app (my
unasked choice). His answers when asked: **iPhone only** (like Cipher and Loom: iOS 27, installed on his iPhone
15 Pro Max with Xcode) and **a full port to Swift** — import, search, timeline, analysis (clustering, vector
spaces, drift, quotation detection) all run on the phone. The web build stays as the reference implementation.

## Qwen decision (Utkarsh, 2026-10-13)
"We need to do a mid run total rewrite: Juice it with QWEN (already installed)" → asked what Qwen should do; his
answer: **Power the app itself** — Qwen runs on the iPhone inside Scrolls: contextual vectors for every occurrence
(real sense separation), labels and explanations of what changed, questions answered from cited quotes, all labelled
as machine output. Models (local, outside iCloud, ~/Developer/scrolls-models): Qwen3-4B-Instruct-2507-4bit (2.26 GB,
his existing model, also used by AttentionMachine and Cipher) + Qwen3-Embedding-0.6B (MLX 8-bit 649 MB and 4-bit DWQ
351 MB, downloaded with his OK). The rewrite centres the spec on Qwen and drops most of the heavy statistical port.
