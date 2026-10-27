"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const slugs_js_1 = require("./slugs.js");
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const collab_js_1 = require("./collab.js");
const highlight_js_1 = __importDefault(require("highlight.js"));
const marked_1 = require("marked");
const sanitize_html_1 = __importDefault(require("sanitize-html"));
function cliArg(name) {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.split("=").slice(1).join("=") : null;
}
const port = Number(cliArg("port") || process.env.PORT || 3210);
const dataDir = cliArg("data") || process.env.DATA_DIR || node_path_1.default.join(process.cwd(), "data");
const notesDir = node_path_1.default.join(dataDir, "notes");
const authFilePath = node_path_1.default.join(dataDir, "auth.json");
const publicDir = node_path_1.default.join(node_path_1.default.resolve(__dirname, ".."), "public");
const ownerSessionCookieName = "md_owner_session";
const ownerLocalStorageTokenKey = "md_owner_token";
const commenterIdCookieName = "md_commenter_id";
const commenterNameCookieName = "md_commenter_name";
const ownerCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const commenterCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const notes = new Map();
const codeRenderer = new marked_1.marked.Renderer();
codeRenderer.code = ({ text, lang }) => {
    const language = (lang || "").trim().split(/\s+/)[0];
    if (language === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
    }
    const validLanguage = language && highlight_js_1.default.getLanguage(language) ? language : null;
    const highlighted = validLanguage
        ? highlight_js_1.default.highlight(text, { language: validLanguage }).value
        : escapeHtml(text);
    const languageClass = validLanguage ? ` class="hljs language-${escapeHtml(validLanguage)}"` : ' class="hljs"';
    return `<pre><code${languageClass}>${highlighted}</code></pre>`;
};
marked_1.marked.setOptions({
    gfm: true,
    breaks: true,
    renderer: codeRenderer,
});
ensureDirectories();
loadNotesIntoMemory();
const app = (0, express_1.default)();
app.set("trust proxy", true);
app.use(express_1.default.json({ limit: "2mb" }));
app.use(express_1.default.urlencoded({ extended: true, limit: "2mb" }));
app.use("/static", express_1.default.static(publicDir));
app.use("/static/mermaid", express_1.default.static(node_path_1.default.join(node_path_1.default.resolve(__dirname, ".."), "node_modules", "mermaid", "dist")));
app.get("/health", (_req, res) => {
    res.type("text/plain").send("ok");
});
app.get("/login", (req, res) => {
    if (isOwnerAuthenticated(req)) {
        res.redirect("/");
        return;
    }
    res.send(renderAuthPage(authConfigured() ? "login" : "setup"));
});
app.get("/", requireOwnerPage, (_req, res) => {
    res.send(renderAppShell("list", "Notes"));
});
app.get("/notes/:id", requireOwnerPage, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).send(renderSimplePage("Not found", `<p>Note not found.</p><p><a href="/">Back</a></p>`));
        return;
    }
    res.send(renderAppShell("editor", note.title, { noteId: note.id }));
});
app.get("/s/:shareId", (req, res) => {
    const note = findNoteByShareId(String(req.params.shareId));
    if (!note || note.shareAccess === "none") {
        res.status(404).send(renderSimplePage("Not found", `<p>Shared note not found.</p>`));
        return;
    }
    res.send(renderAppShell("public", note.title, { shareId: note.shareId, shareAccess: note.shareAccess }));
});
app.get("/api/viewer", (req, res) => {
    res.json({
        ok: true,
        authConfigured: authConfigured(),
        ownerAuthenticated: isOwnerAuthenticated(req),
        ownerLocalStorageTokenKey,
        viewer: buildViewerInfo(req),
    });
});
app.post("/api/auth/setup", (req, res) => {
    if (authConfigured()) {
        res.status(400).json({ ok: false, error: "Password already configured." });
        return;
    }
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    if (password.length < 8) {
        res.status(400).json({ ok: false, error: "Use at least 8 characters." });
        return;
    }
    if (password !== confirmPassword) {
        res.status(400).json({ ok: false, error: "Passwords do not match." });
        return;
    }
    const token = initializeOwnerAuth(password);
    res.json({ ok: true, token, ownerLocalStorageTokenKey });
});
app.post("/api/auth/login", (req, res) => {
    if (!authConfigured()) {
        res.status(400).json({ ok: false, error: "Password is not configured yet." });
        return;
    }
    const password = String(req.body.password || "");
    if (!passwordMatches(password)) {
        res.status(401).json({ ok: false, error: "Wrong password." });
        return;
    }
    const token = issueOwnerToken();
    res.json({ ok: true, token, ownerLocalStorageTokenKey });
});
app.post("/api/auth/token", (req, res) => {
    const token = String(req.body.token || "");
    if (!token || !verifyOwnerToken(token)) {
        clearOwnerSessionCookie(req, res);
        res.status(401).json({ ok: false });
        return;
    }
    setOwnerSessionCookie(req, res, token);
    res.json({ ok: true });
});
app.post("/api/auth/logout", (req, res) => {
    const token = getOwnerSessionToken(req);
    if (token) {
        revokeOwnerToken(token);
    }
    clearOwnerSessionCookie(req, res);
    res.json({ ok: true });
});
app.get("/api/keys", requireOwnerApi, (_req, res) => {
    res.json({ ok: true, keys: listApiKeys() });
});
app.post("/api/keys", requireOwnerApi, (req, res) => {
    const label = String(req.body.label || "unnamed");
    const result = createApiKey(label);
    res.json({ ok: true, ...result });
});
app.delete("/api/keys/:id", requireOwnerApi, (req, res) => {
    const deleted = deleteApiKey(String(req.params.id));
    if (!deleted) {
        res.status(404).json({ ok: false, error: "API key not found." });
        return;
    }
    res.json({ ok: true });
});
app.post("/api/notes/:id/edit", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const edits = req.body.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        res.status(400).json({ ok: false, error: "edits must be a non-empty array of {oldText, newText}." });
        return;
    }
    let workingCollab = note.collab;
    let markdown = (0, collab_js_1.collabToMarkdown)(workingCollab);
    let senderCounter = 0;
    const errors = [];
    const idListUpdates = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldText = String(edit?.oldText || "");
        const newText = String(edit?.newText || "");
        if (!oldText) {
            errors.push(`Edit ${i}: oldText is empty.`);
            continue;
        }
        const firstIndex = markdown.indexOf(oldText);
        if (firstIndex === -1) {
            errors.push(`Edit ${i}: oldText not found.`);
            continue;
        }
        const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
        if (secondIndex !== -1) {
            errors.push(`Edit ${i}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
            continue;
        }
        let nextClientCounter = senderCounter + 1;
        const mutations = [];
        if (oldText.length > 0) {
            mutations.push({
                name: "delete",
                clientCounter: nextClientCounter++,
                args: {
                    startId: (0, collab_js_1.idAtIndex)(workingCollab, firstIndex),
                    endId: (0, collab_js_1.idAtIndex)(workingCollab, firstIndex + oldText.length - 1),
                    contentLength: oldText.length,
                },
            });
        }
        if (newText.length > 0) {
            mutations.push({
                name: "insert",
                clientCounter: nextClientCounter++,
                args: {
                    before: firstIndex > 0 ? (0, collab_js_1.idBeforeIndex)(workingCollab, firstIndex) : null,
                    id: { bunchId: node_crypto_1.default.randomUUID(), counter: 0 },
                    content: newText,
                    isInWord: false,
                },
            });
        }
        const result = (0, collab_js_1.applyClientMutations)(workingCollab, mutations);
        workingCollab = result.state;
        markdown = result.markdown;
        idListUpdates.push(...result.idListUpdates);
        senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
    }
    if (errors.length > 0) {
        res.status(400).json({ ok: false, errors });
        return;
    }
    note.collab = workingCollab;
    note.updatedAt = nowIso();
    const titleChanged = Object.prototype.hasOwnProperty.call(req.body || {}, "title")
        && normalizeTitle(String(req.body.title || note.title)) !== note.title;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "title")) {
        note.title = normalizeTitle(String(req.body.title || note.title));
    }
    persistNote(note, false);
    if (titleChanged) {
        broadcastEditorHello(note);
    }
    else if (idListUpdates.length > 0) {
        broadcastEditorMutation(note, {
            type: "mutation",
            senderId: "__api__",
            senderCounter,
            serverCounter: note.collab.serverCounter,
            markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
            idListUpdates,
        });
    }
    broadcastNoteUpdate(note);
    res.json({ ok: true, savedAt: note.updatedAt });
});
app.post("/api/notes/:id/threads", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const quote = String(req.body.quote || "");
    const body = normalizeCommentBody(String(req.body.body || ""));
    if (!quote || !body) {
        res.status(400).json({ ok: false, error: "quote and body are required." });
        return;
    }
    const markdown = (0, collab_js_1.collabToMarkdown)(note.collab);
    const start = markdown.indexOf(quote);
    if (start === -1) {
        res.status(400).json({ ok: false, error: "Quoted text not found in note." });
        return;
    }
    const prefix = markdown.slice(Math.max(0, start - 32), start);
    const end = start + quote.length;
    const suffix = markdown.slice(end, end + 32);
    const bearer = getBearerToken(req);
    const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
    const authorName = apiKeyLabel || "Owner";
    const anchor = { quote, prefix, suffix, start, end };
    const thread = {
        id: createId(10),
        resolved: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        anchor,
        messages: [
            {
                id: createId(10),
                parentId: null,
                authorId: "__owner__",
                authorName,
                body,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            },
        ],
    };
    note.threads.push(thread);
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, thread: { id: thread.id } });
});
app.post("/api/notes/:id/threads/:threadId/replies", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const thread = note.threads.find((t) => t.id === String(req.params.threadId));
    if (!thread) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
    }
    const body = normalizeCommentBody(String(req.body.body || ""));
    const parentMessageId = String(req.body.parentMessageId || thread.messages[0]?.id || "");
    if (!body) {
        res.status(400).json({ ok: false, error: "body is required." });
        return;
    }
    if (!thread.messages.some((m) => m.id === parentMessageId)) {
        res.status(400).json({ ok: false, error: "Parent message not found." });
        return;
    }
    const bearer = getBearerToken(req);
    const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
    const authorName = apiKeyLabel || "Owner";
    const timestamp = nowIso();
    thread.messages.push({
        id: createId(10),
        parentId: parentMessageId,
        authorId: "__owner__",
        authorName,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    thread.updatedAt = timestamp;
    note.updatedAt = timestamp;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true });
});
app.patch("/api/notes/:id/threads/:threadId", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const thread = note.threads.find((t) => t.id === String(req.params.threadId));
    if (!thread) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
    }
    thread.resolved = Boolean(req.body.resolved);
    thread.updatedAt = nowIso();
    note.updatedAt = thread.updatedAt;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true });
});
app.delete("/api/notes/:id/threads/:threadId", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    note.threads = note.threads.filter((t) => t.id !== String(req.params.threadId));
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true });
});
app.patch("/api/notes/:id/messages/:messageId", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const located = locateMessage(note, String(req.params.messageId));
    if (!located) {
        res.status(404).json({ ok: false, error: "Message not found." });
        return;
    }
    const body = normalizeCommentBody(String(req.body.body || ""));
    if (!body) {
        res.status(400).json({ ok: false, error: "Body is required." });
        return;
    }
    located.message.body = body;
    located.message.updatedAt = nowIso();
    located.thread.updatedAt = located.message.updatedAt;
    note.updatedAt = located.message.updatedAt;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true });
});
app.delete("/api/notes/:id/messages/:messageId", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const located = locateMessage(note, String(req.params.messageId));
    if (!located) {
        res.status(404).json({ ok: false, error: "Message not found." });
        return;
    }
    located.thread.messages = located.thread.messages.filter((m) => m.id !== located.message.id);
    if (located.thread.messages.length === 0) {
        note.threads = note.threads.filter((t) => t.id !== located.thread.id);
    }
    else {
        located.thread.updatedAt = nowIso();
    }
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true });
});
app.delete("/api/notes/:id", requireOwnerApi, (req, res) => {
    const id = String(req.params.id);
    const note = notes.get(id);
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    notes.delete(id);
    try {
        node_fs_1.default.unlinkSync(noteMarkdownPath(id));
    }
    catch { }
    try {
        node_fs_1.default.unlinkSync(noteMetaPath(id));
    }
    catch { }
    res.json({ ok: true });
});
app.get("/api/notes", requireOwnerApi, (req, res) => {
    const query = String(req.query.q || "");
    const results = searchNotes(query);
    res.json({ ok: true, notes: results });
});
app.post("/api/notes", requireOwnerApi, (_req, res) => {
    const note = createNote();
    res.json({ ok: true, note: summarizeNote(note, "") });
});
app.get("/api/notes/:id", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const offset = req.query.offset ? Number(req.query.offset) : null;
    const limit = req.query.limit ? Number(req.query.limit) : null;
    if (offset !== null || limit !== null) {
        const lines = (0, collab_js_1.collabToMarkdown)(note.collab).split("\n");
        const start = Math.max(0, (offset || 1) - 1);
        const end = limit ? Math.min(lines.length, start + limit) : lines.length;
        const slice = lines.slice(start, end);
        const totalLines = lines.length;
        const remaining = totalLines - end;
        res.json({
            ok: true,
            note: {
                id: note.id,
                title: note.title,
                totalLines,
                offset: start + 1,
                limit: slice.length,
                remaining,
                content: slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
            },
        });
        return;
    }
    res.json({ ok: true, ...serializeNoteForClient(note, req) });
});
app.put("/api/notes/:id", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    const titleProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "title");
    const markdownProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "markdown");
    const shareAccessProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "shareAccess");
    const currentMarkdown = (0, collab_js_1.collabToMarkdown)(note.collab);
    const nextTitle = titleProvided ? normalizeTitle(String(req.body.title || note.title)) : note.title;
    const nextMarkdown = markdownProvided ? String(req.body.markdown || "") : currentMarkdown;
    const nextShareAccess = shareAccessProvided && ["none", "view", "comment", "edit"].includes(req.body.shareAccess)
        ? req.body.shareAccess
        : note.shareAccess;
    const titleChanged = nextTitle !== note.title;
    const markdownChanged = nextMarkdown !== currentMarkdown;
    const shareAccessChanged = nextShareAccess !== note.shareAccess;
    note.title = nextTitle;
    note.shareAccess = nextShareAccess;
    if (markdownChanged) {
        note.collab = (0, collab_js_1.collabFromMarkdown)(nextMarkdown, note.collab.serverCounter + 1);
    }
    note.updatedAt = nowIso();
    persistNote(note, false);
    if (shareAccessChanged) {
        enforceShareAccessForConnections(note);
    }
    if (titleChanged || markdownChanged || shareAccessChanged) {
        broadcastEditorHello(note);
        broadcastNoteUpdate(note);
    }
    res.json({ ok: true, savedAt: note.updatedAt, shareAccess: note.shareAccess });
});
app.get("/api/notes/:id/collab", requireOwnerApi, (req, res) => {
    const note = notes.get(String(req.params.id));
    if (!note) {
        res.status(404).json({ ok: false, error: "Note not found." });
        return;
    }
    res.json({
        ok: true,
        noteId: note.id,
        title: note.title,
        shareId: note.shareId,
        shareUrl: makeShareUrl(req, note.shareId),
        serverCounter: note.collab.serverCounter,
        collabState: (0, collab_js_1.saveCollabState)(note.collab),
    });
});
app.get("/api/share/:shareId/collab", (req, res) => {
    const note = requireShareAccess(req, res, "edit");
    if (!note)
        return;
    res.json({
        ok: true,
        noteId: note.id,
        title: note.title,
        shareId: note.shareId,
        shareUrl: makeShareUrl(req, note.shareId),
        serverCounter: note.collab.serverCounter,
        collabState: (0, collab_js_1.saveCollabState)(note.collab),
    });
});
app.post("/api/render", requireOwnerApi, (req, res) => {
    const markdown = String(req.body.markdown || "");
    res.json({ ok: true, html: renderMarkdown(markdown) });
});
app.post("/api/share/:shareId/edit", (req, res) => {
    const note = requireShareAccess(req, res, "edit");
    if (!note)
        return;
    const edits = req.body.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        res.status(400).json({ ok: false, error: "edits must be a non-empty array of {oldText, newText}." });
        return;
    }
    let workingCollab = note.collab;
    let markdown = (0, collab_js_1.collabToMarkdown)(workingCollab);
    let senderCounter = 0;
    const errors = [];
    const idListUpdates = [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldText = String(edit?.oldText || "");
        const newText = String(edit?.newText || "");
        if (!oldText) {
            errors.push(`Edit ${i}: oldText is empty.`);
            continue;
        }
        const firstIndex = markdown.indexOf(oldText);
        if (firstIndex === -1) {
            errors.push(`Edit ${i}: oldText not found.`);
            continue;
        }
        const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
        if (secondIndex !== -1) {
            errors.push(`Edit ${i}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
            continue;
        }
        let nextClientCounter = senderCounter + 1;
        const mutations = [];
        if (oldText.length > 0) {
            mutations.push({
                name: "delete",
                clientCounter: nextClientCounter++,
                args: {
                    startId: (0, collab_js_1.idAtIndex)(workingCollab, firstIndex),
                    endId: (0, collab_js_1.idAtIndex)(workingCollab, firstIndex + oldText.length - 1),
                    contentLength: oldText.length,
                },
            });
        }
        if (newText.length > 0) {
            mutations.push({
                name: "insert",
                clientCounter: nextClientCounter++,
                args: {
                    before: firstIndex > 0 ? (0, collab_js_1.idBeforeIndex)(workingCollab, firstIndex) : null,
                    id: { bunchId: node_crypto_1.default.randomUUID(), counter: 0 },
                    content: newText,
                    isInWord: false,
                },
            });
        }
        const result = (0, collab_js_1.applyClientMutations)(workingCollab, mutations);
        workingCollab = result.state;
        markdown = result.markdown;
        idListUpdates.push(...result.idListUpdates);
        senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
    }
    if (errors.length > 0) {
        res.status(400).json({ ok: false, errors });
        return;
    }
    note.collab = workingCollab;
    note.updatedAt = nowIso();
    persistNote(note, false);
    if (idListUpdates.length > 0) {
        broadcastEditorMutation(note, {
            type: "mutation",
            senderId: "__api__",
            senderCounter,
            serverCounter: note.collab.serverCounter,
            markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
            idListUpdates,
        });
    }
    broadcastNoteUpdate(note);
    res.json({ ok: true, savedAt: note.updatedAt });
});
app.post("/api/share/:shareId/render", (req, res) => {
    const note = requireShareAccess(req, res, "view");
    if (!note)
        return;
    const markdown = String(req.body.markdown || "");
    res.json({ ok: true, html: renderMarkdown(markdown) });
});
app.get("/api/share/:shareId", (req, res) => {
    const note = requireShareAccess(req, res, "view");
    if (!note)
        return;
    res.json({ ok: true, ...serializeNoteForClient(note, req) });
});
app.get("/api/share/:shareId/note", (req, res) => {
    const note = requireShareAccess(req, res, "view");
    if (!note)
        return;
    res.json({
        ok: true,
        note: {
            id: note.id,
            title: note.title,
            markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
            shareAccess: note.shareAccess,
            updatedAt: note.updatedAt,
        },
        threads: serializeThreads(note, req),
    });
});
app.post("/api/share/:shareId/identity", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const name = normalizeCommenterName(String(req.body.name || ""));
    if (!name) {
        res.status(400).json({ ok: false, error: "Name is required." });
        return;
    }
    const commenterId = getOrCreateCommenterId(req, res);
    setCommenterNameCookie(req, res, name);
    res.json({
        ok: true,
        commenterIdSet: Boolean(commenterId),
        viewer: buildViewerInfo(req, { commenterNameOverride: name, hasCommenterIdentityOverride: true }),
    });
});
app.post("/api/share/:shareId/threads", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const identity = ensureCommentAuthor(req, res);
    if (!identity) {
        res.status(400).json({ ok: false, error: "Set your name first." });
        return;
    }
    const anchor = sanitizeAnchor(req.body.anchor);
    const body = normalizeCommentBody(String(req.body.body || ""));
    if (!anchor || !body) {
        res.status(400).json({ ok: false, error: "Anchor and comment body are required." });
        return;
    }
    const thread = {
        id: createId(10),
        resolved: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        anchor,
        messages: [
            {
                id: createId(10),
                parentId: null,
                authorId: identity.authorId,
                authorName: identity.authorName,
                body,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            },
        ],
    };
    note.threads.push(thread);
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.post("/api/share/:shareId/threads/:threadId/replies", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const thread = note.threads.find((item) => item.id === String(req.params.threadId));
    if (!thread) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
    }
    const identity = ensureCommentAuthor(req, res);
    if (!identity) {
        res.status(400).json({ ok: false, error: "Set your name first." });
        return;
    }
    const body = normalizeCommentBody(String(req.body.body || ""));
    if (!body) {
        res.status(400).json({ ok: false, error: "Reply body is required." });
        return;
    }
    const requestedParentId = typeof req.body.parentMessageId === "string" ? String(req.body.parentMessageId) : "";
    const parentMessageId = requestedParentId || thread.messages[0]?.id || "";
    if (!parentMessageId || !thread.messages.some((message) => message.id === parentMessageId)) {
        res.status(400).json({ ok: false, error: "Parent message not found." });
        return;
    }
    const timestamp = nowIso();
    thread.messages.push({
        id: createId(10),
        parentId: parentMessageId,
        authorId: identity.authorId,
        authorName: identity.authorName,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    thread.updatedAt = timestamp;
    note.updatedAt = timestamp;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.patch("/api/share/:shareId/threads/:threadId", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const thread = note.threads.find((item) => item.id === String(req.params.threadId));
    if (!thread) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
    }
    if (!canManageThread(req, thread)) {
        res.status(403).json({ ok: false, error: "Not allowed." });
        return;
    }
    thread.resolved = Boolean(req.body.resolved);
    thread.updatedAt = nowIso();
    note.updatedAt = thread.updatedAt;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.delete("/api/share/:shareId/threads/:threadId", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const thread = note.threads.find((item) => item.id === String(req.params.threadId));
    if (!thread) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
    }
    if (!isOwnerAuthenticated(req)) {
        res.status(403).json({ ok: false, error: "Only the owner can delete a whole thread." });
        return;
    }
    note.threads = note.threads.filter((item) => item.id !== thread.id);
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.patch("/api/share/:shareId/messages/:messageId", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const located = locateMessage(note, String(req.params.messageId));
    if (!located) {
        res.status(404).json({ ok: false, error: "Message not found." });
        return;
    }
    if (!canManageMessage(req, located.message)) {
        res.status(403).json({ ok: false, error: "Not allowed." });
        return;
    }
    const body = normalizeCommentBody(String(req.body.body || ""));
    if (!body) {
        res.status(400).json({ ok: false, error: "Body is required." });
        return;
    }
    located.message.body = body;
    located.message.updatedAt = nowIso();
    located.thread.updatedAt = located.message.updatedAt;
    note.updatedAt = located.message.updatedAt;
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.delete("/api/share/:shareId/messages/:messageId", (req, res) => {
    const note = requireShareAccess(req, res, "comment");
    if (!note)
        return;
    const located = locateMessage(note, String(req.params.messageId));
    if (!located) {
        res.status(404).json({ ok: false, error: "Message not found." });
        return;
    }
    if (!canManageMessage(req, located.message)) {
        res.status(403).json({ ok: false, error: "Not allowed." });
        return;
    }
    located.thread.messages = located.thread.messages.filter((message) => message.id !== located.message.id);
    if (located.thread.messages.length === 0) {
        note.threads = note.threads.filter((thread) => thread.id !== located.thread.id);
    }
    else {
        located.thread.updatedAt = nowIso();
    }
    note.updatedAt = nowIso();
    persistNote(note);
    broadcastThreadsUpdated(note);
    res.json({ ok: true, threads: serializeThreads(note, req) });
});
app.use((_req, res) => {
    res.status(404).send(renderSimplePage("Not found", `<p>Page not found.</p>`));
});
app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ ok: false, error: "Internal server error." });
});
const server = node_http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
const CURSOR_COLORS = ["#4285f4", "#ea4335", "#34a853", "#fbbc04", "#9c27b0", "#ff6d00", "#00bcd4", "#e91e63"];
let nextColorIndex = 0;
const clients = [];
let clientIdCounter = 0;
const heartbeatInterval = setInterval(() => {
    for (const conn of clients) {
        if (!conn.alive) {
            conn.ws.terminate();
            continue;
        }
        conn.alive = false;
        if (conn.ws.readyState === 1) {
            conn.ws.ping();
        }
    }
}, 30000);
wss.on("close", () => clearInterval(heartbeatInterval));
wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const noteId = url.searchParams.get("noteId") || "";
    const shareId = url.searchParams.get("shareId") || "";
    if (noteId) {
        if (!isOwnerAuthenticatedIncomingRequest(req)) {
            ws.close();
            return;
        }
        const note = notes.get(noteId);
        if (!note) {
            ws.close();
            return;
        }
        const clientId = `c${++clientIdCounter}`;
        const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
        const conn = { ws, kind: "editor", noteId: note.id, shareId: note.shareId, clientId, name: "Owner", color, alive: true };
        clients.push(conn);
        sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
        sendExistingPresence(conn);
        ws.on("pong", () => { conn.alive = true; });
        ws.on("message", (data) => handleEditorMessage(conn, String(data)));
        ws.on("close", () => handleDisconnect(conn));
        ws.on("error", () => handleDisconnect(conn));
        return;
    }
    if (shareId) {
        const note = findNoteByShareId(shareId);
        if (!note || note.shareAccess === "none") {
            ws.close();
            return;
        }
        if (note.shareAccess === "edit") {
            const commenterName = getCommenterIdentityFromHeaders(req.headers).name;
            const clientId = `c${++clientIdCounter}`;
            const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
            const conn = { ws, kind: "public-editor", noteId: note.id, shareId: note.shareId, clientId, name: commenterName || "Anonymous", color, alive: true };
            clients.push(conn);
            sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
            sendExistingPresence(conn);
            ws.on("pong", () => { conn.alive = true; });
            ws.on("message", (data) => handleEditorMessage(conn, String(data)));
            ws.on("close", () => handleDisconnect(conn));
            ws.on("error", () => handleDisconnect(conn));
            return;
        }
        const clientId = `c${++clientIdCounter}`;
        const conn = { ws, kind: "public-viewer", noteId: note.id, shareId: note.shareId, clientId, name: "", color: "", alive: true };
        clients.push(conn);
        ws.on("pong", () => { conn.alive = true; });
        ws.on("close", () => handleDisconnect(conn));
        ws.on("error", () => handleDisconnect(conn));
        return;
    }
    ws.close();
});
function isCollaborativeConn(conn, noteId) {
    return (conn.kind === "editor" || conn.kind === "public-editor") && conn.noteId === noteId;
}
function handleDisconnect(conn) {
    const index = clients.indexOf(conn);
    if (index !== -1) {
        clients.splice(index, 1);
    }
    if (conn.kind === "editor" || conn.kind === "public-editor") {
        broadcastPresenceLeave(conn);
    }
}
function handleEditorMessage(conn, data) {
    let message;
    try {
        message = JSON.parse(data);
    }
    catch {
        return;
    }
    if (message.type === "presence") {
        const presenceMsg = message;
        if (presenceMsg.clientId !== conn.clientId) {
            return;
        }
        conn.selection = presenceMsg.selection;
        broadcastPresence(conn, presenceMsg);
        return;
    }
    if (message.type !== "mutation" || !message.clientId || !Array.isArray(message.mutations) || message.mutations.length === 0) {
        return;
    }
    const mutationMsg = message;
    if (mutationMsg.clientId !== conn.clientId) {
        return;
    }
    const note = notes.get(conn.noteId);
    if (!note) {
        return;
    }
    const senderCounter = mutationMsg.mutations.at(-1)?.clientCounter || 0;
    const lastAcknowledgedCounter = note.clientAcks.get(mutationMsg.clientId) || 0;
    const freshMutations = mutationMsg.mutations.filter((mutation) => mutation.clientCounter > lastAcknowledgedCounter);
    if (freshMutations.length === 0) {
        sendServerMessage(conn.ws, {
            type: "mutation",
            senderId: mutationMsg.clientId,
            senderCounter,
            serverCounter: note.collab.serverCounter,
            markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
            idListUpdates: [],
        });
        return;
    }
    let result;
    try {
        result = (0, collab_js_1.applyClientMutations)(note.collab, freshMutations);
    }
    catch (error) {
        console.error(error);
        sendServerMessage(conn.ws, { ...buildHelloMessage(note), clientId: conn.clientId });
        return;
    }
    note.clientAcks.set(mutationMsg.clientId, senderCounter);
    if (!result.changed) {
        sendServerMessage(conn.ws, {
            type: "mutation",
            senderId: mutationMsg.clientId,
            senderCounter,
            serverCounter: note.collab.serverCounter,
            markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
            idListUpdates: [],
        });
        return;
    }
    note.collab = result.state;
    note.updatedAt = nowIso();
    persistNote(note, false);
    broadcastEditorMutation(note, {
        type: "mutation",
        senderId: mutationMsg.clientId,
        senderCounter,
        serverCounter: note.collab.serverCounter,
        markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
        idListUpdates: result.idListUpdates,
    });
    broadcastNoteUpdate(note);
}
function sendServerMessage(ws, message) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(message));
    }
}
function buildHelloMessage(note) {
    return {
        type: "hello",
        noteId: note.id,
        title: note.title,
        shareId: note.shareId,
        markdown: (0, collab_js_1.collabToMarkdown)(note.collab),
        idListState: (0, collab_js_1.saveCollabState)(note.collab).idListState,
        serverCounter: note.collab.serverCounter,
    };
}
function sendExistingPresence(target) {
    for (const conn of clients) {
        if (conn === target || !isCollaborativeConn(conn, target.noteId) || !conn.selection) {
            continue;
        }
        sendServerMessage(target.ws, {
            type: "presence",
            clientId: conn.clientId,
            name: conn.name,
            color: conn.color,
            selection: conn.selection,
        });
    }
}
function broadcastEditorHello(note) {
    const message = buildHelloMessage(note);
    for (const conn of clients) {
        if (isCollaborativeConn(conn, note.id)) {
            sendServerMessage(conn.ws, conn.clientId ? { ...message, clientId: conn.clientId } : message);
        }
    }
}
function broadcastEditorMutation(note, message) {
    for (const conn of clients) {
        if (isCollaborativeConn(conn, note.id)) {
            sendServerMessage(conn.ws, message);
        }
    }
}
function enforceShareAccessForConnections(note) {
    for (const conn of [...clients]) {
        if (conn.shareId !== note.shareId) {
            continue;
        }
        if (conn.kind === "public-editor" && note.shareAccess !== "edit") {
            try {
                conn.ws.close();
            }
            catch { }
            continue;
        }
        if (conn.kind === "public-viewer" && note.shareAccess === "none") {
            try {
                conn.ws.close();
            }
            catch { }
        }
    }
}
function broadcastNoteUpdate(note) {
    const message = {
        type: "updated",
        noteId: note.id,
        shareId: note.shareId,
        updatedAt: note.updatedAt,
    };
    for (const conn of clients) {
        if (conn.kind === "public-viewer" && conn.shareId === note.shareId) {
            sendServerMessage(conn.ws, message);
        }
    }
}
function broadcastThreadsUpdated(note) {
    const message = { type: "threads-updated", noteId: note.id, shareId: note.shareId };
    for (const conn of clients) {
        if (conn.noteId === note.id) {
            sendServerMessage(conn.ws, message);
        }
    }
}
function broadcastPresence(sender, message) {
    const outgoing = {
        type: "presence",
        clientId: sender.clientId,
        name: sender.name,
        color: sender.color,
        selection: message.selection,
    };
    for (const conn of clients) {
        if (conn === sender)
            continue;
        if (isCollaborativeConn(conn, sender.noteId)) {
            sendServerMessage(conn.ws, outgoing);
        }
    }
}
function broadcastPresenceLeave(sender) {
    const outgoing = {
        type: "presence-leave",
        clientId: sender.clientId,
    };
    for (const conn of clients) {
        if (conn === sender)
            continue;
        if (isCollaborativeConn(conn, sender.noteId)) {
            sendServerMessage(conn.ws, outgoing);
        }
    }
}
server.listen(port, () => {
    console.log(`toj listening on http://localhost:${port}`);
    console.log(`data: ${node_path_1.default.resolve(dataDir)}`);
});
function ensureDirectories() {
    node_fs_1.default.mkdirSync(dataDir, { recursive: true });
    node_fs_1.default.mkdirSync(notesDir, { recursive: true });
}
function loadNotesIntoMemory() {
    notes.clear();
    const files = node_fs_1.default.readdirSync(notesDir).filter((file) => file.endsWith(".md"));
    for (const file of files) {
        const id = node_path_1.default.basename(file, ".md");
        const markdownPath = noteMarkdownPath(id);
        const metaPath = noteMetaPath(id);
        if (!node_fs_1.default.existsSync(metaPath)) {
            continue;
        }
        const markdown = node_fs_1.default.readFileSync(markdownPath, "utf8");
        const meta = readJson(metaPath, null);
        if (!meta) {
            continue;
        }
        const threads = Array.isArray(meta.threads)
            ? meta.threads.map((thread) => ({
                ...thread,
                messages: Array.isArray(thread.messages)
                    ? thread.messages.map((message) => ({
                        ...message,
                        parentId: typeof message.parentId === "string" ? message.parentId : null,
                    }))
                    : [],
            }))
            : [];
        let collab;
        if (meta.collab) {
            collab = (0, collab_js_1.loadCollabState)(meta.collab);
        }
        else if (meta.collabState) {
            collab = (0, collab_js_1.loadCollabState)(meta.collabState);
        }
        else {
            collab = (0, collab_js_1.collabFromMarkdown)(markdown);
        }
        notes.set(id, {
            ...meta,
            shareAccess: meta.shareAccess || "none",
            threads,
            collab,
            clientAcks: new Map(),
        });
    }
}
function noteMarkdownPath(id) {
    return node_path_1.default.join(notesDir, `${id}.md`);
}
function noteMetaPath(id) {
    return node_path_1.default.join(notesDir, `${id}.json`);
}
function readJson(filePath, fallback) {
    try {
        return JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
    }
    catch {
        return fallback;
    }
}
function writeJson(filePath, value) {
    node_fs_1.default.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function createNote() {
    const timestamp = nowIso();
    let id = (0, slugs_js_1.createSlug)();
    // ensure uniqueness (collision extremely unlikely with ~2M combinations)
    while (notes.has(id))
        id = (0, slugs_js_1.createSlug)();
    const note = {
        id,
        title: "untitled",
        shareId: createShortId(14),
        shareAccess: "none",
        createdAt: timestamp,
        updatedAt: timestamp,
        threads: [],
        collab: (0, collab_js_1.newCollabState)(),
        clientAcks: new Map(),
    };
    notes.set(id, note);
    persistNote(note);
    return note;
}
function persistNote(note, broadcastUpdate = true) {
    const markdown = (0, collab_js_1.collabToMarkdown)(note.collab);
    const meta = {
        id: note.id,
        title: note.title,
        shareId: note.shareId,
        shareAccess: note.shareAccess,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        threads: note.threads,
        collab: (0, collab_js_1.saveCollabState)(note.collab),
    };
    node_fs_1.default.writeFileSync(noteMarkdownPath(note.id), markdown, "utf8");
    writeJson(noteMetaPath(note.id), meta);
    if (broadcastUpdate) {
        broadcastNoteUpdate(note);
    }
}
function searchNotes(query) {
    const needle = query.trim().toLowerCase();
    return Array.from(notes.values())
        .map((note) => summarizeNote(note, needle))
        .filter((note) => {
        if (!needle) {
            return true;
        }
        return note.title.toLowerCase().includes(needle) || note.snippet.toLowerCase().includes(needle);
    })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function summarizeNote(note, needle) {
    return {
        id: note.id,
        title: note.title,
        updatedAt: note.updatedAt,
        shareId: note.shareId,
        snippet: buildSnippet(note, needle),
    };
}
function buildSnippet(note, needle) {
    const source = (0, collab_js_1.collabToMarkdown)(note.collab).replace(/\s+/g, " ").trim();
    if (!source) {
        return "";
    }
    if (!needle) {
        return source.slice(0, 140);
    }
    const index = source.toLowerCase().indexOf(needle);
    if (index === -1) {
        return source.slice(0, 140);
    }
    const start = Math.max(0, index - 40);
    const end = Math.min(source.length, index + needle.length + 80);
    return source.slice(start, end);
}
function findNoteByShareId(shareId) {
    for (const note of notes.values()) {
        if (note.shareId === shareId) {
            return note;
        }
    }
    return null;
}
function locateMessage(note, messageId) {
    for (const thread of note.threads) {
        const message = thread.messages.find((item) => item.id === messageId);
        if (message) {
            return { thread, message };
        }
    }
    return null;
}
function buildViewerInfo(req, overrides) {
    const commenter = getCommenterIdentity(req);
    return {
        isOwner: isOwnerAuthenticated(req),
        commenterName: overrides?.commenterNameOverride ?? commenter.name,
        hasCommenterIdentity: overrides?.hasCommenterIdentityOverride ?? Boolean(commenter.id),
    };
}
function serializeThreads(note, req) {
    const viewer = buildViewerInfo(req);
    const commenter = getCommenterIdentity(req);
    return [...note.threads]
        .sort((a, b) => {
        const startDelta = a.anchor.start - b.anchor.start;
        if (startDelta !== 0) {
            return startDelta;
        }
        return a.createdAt.localeCompare(b.createdAt);
    })
        .map((thread) => ({
        id: thread.id,
        resolved: thread.resolved,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        anchor: thread.anchor,
        canReply: viewer.isOwner || viewer.hasCommenterIdentity,
        canResolve: viewer.isOwner || viewer.hasCommenterIdentity,
        canDeleteThread: viewer.isOwner,
        messages: [...thread.messages]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((message) => ({
            id: message.id,
            parentId: message.parentId,
            authorName: message.authorName,
            body: message.body,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            canEdit: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
            canDelete: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
        })),
    }));
}
function serializeNoteForClient(note, req) {
    const markdown = (0, collab_js_1.collabToMarkdown)(note.collab);
    return {
        note: {
            id: note.id,
            title: note.title,
            markdown,
            renderedHtml: renderMarkdown(markdown),
            shareId: note.shareId,
            shareAccess: note.shareAccess,
            shareUrl: makeShareUrl(req, note.shareId),
            updatedAt: note.updatedAt,
            createdAt: note.createdAt,
        },
        viewer: buildViewerInfo(req),
        threads: serializeThreads(note, req),
    };
}
function requireOwnerPage(req, res, next) {
    if (!isOwnerAuthenticated(req)) {
        res.redirect("/login");
        return;
    }
    next();
}
function requireOwnerApi(req, res, next) {
    if (!isOwnerAuthenticated(req)) {
        res.status(401).json({ ok: false, error: "Unauthorized." });
        return;
    }
    next();
}
const shareAccessLevels = { none: 0, view: 1, comment: 2, edit: 3 };
function requireShareAccess(req, res, minAccess) {
    const note = findNoteByShareId(String(req.params.shareId));
    if (!note) {
        res.status(404).json({ ok: false, error: "Shared note not found." });
        return null;
    }
    if (isOwnerAuthenticated(req)) {
        return note;
    }
    if (shareAccessLevels[note.shareAccess] < shareAccessLevels[minAccess]) {
        res.status(404).json({ ok: false, error: "Shared note not found." });
        return null;
    }
    return note;
}
function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + 1);
    }
    return count;
}
function normalizeTitle(input) {
    return input.trim().slice(0, 160) || "untitled";
}
function normalizeCommentBody(input) {
    return input.trim().slice(0, 4000);
}
function normalizeCommenterName(input) {
    return input.trim().slice(0, 80);
}
function sanitizeAnchor(input) {
    if (!input || typeof input !== "object") {
        return null;
    }
    const source = input;
    const quote = String(source.quote || "").slice(0, 1000);
    const prefix = String(source.prefix || "").slice(0, 200);
    const suffix = String(source.suffix || "").slice(0, 200);
    const start = Number(source.start);
    const end = Number(source.end);
    if (!quote || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        return null;
    }
    return { quote, prefix, suffix, start, end };
}
function renderMarkdown(markdown) {
    const rawHtml = marked_1.marked.parse(markdown);
    return (0, sanitize_html_1.default)(rawHtml, {
        allowedTags: sanitize_html_1.default.defaults.allowedTags.concat([
            "img",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "pre",
            "code",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
            "blockquote",
            "span",
        ]),
        allowedAttributes: {
            a: ["href", "name", "target", "rel"],
            img: ["src", "alt", "title"],
            code: ["class"],
            span: ["class"],
        },
        allowedClasses: {
            code: ["hljs", /^language-/],
            span: [/^hljs.*/],
            pre: ["mermaid"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        transformTags: {
            a: sanitize_html_1.default.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
        },
    });
}
function makeShareUrl(req, shareId) {
    return `${req.protocol}://${req.get("host")}/s/${shareId}`;
}
function nowIso() {
    return new Date().toISOString();
}
function createShortId(length = 8) {
    return node_crypto_1.default.randomBytes(length).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, length);
}
function createId(length = 12) {
    return createShortId(length);
}
function escapeHtml(input) {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function hashSecret(value, salt) {
    return node_crypto_1.default.scryptSync(value, salt, 64).toString("hex");
}
function secureEqualsHex(a, b) {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length) {
        return false;
    }
    return node_crypto_1.default.timingSafeEqual(left, right);
}
function loadAuthData() {
    return readJson(authFilePath, null);
}
function saveAuthData(authData) {
    writeJson(authFilePath, authData);
}
function authConfigured() {
    const auth = loadAuthData();
    return Boolean(auth?.passwordSalt && auth?.passwordHash);
}
function passwordMatches(password) {
    const auth = loadAuthData();
    if (!auth) {
        return false;
    }
    return secureEqualsHex(hashSecret(password, auth.passwordSalt), auth.passwordHash);
}
function initializeOwnerAuth(password) {
    const salt = node_crypto_1.default.randomBytes(16).toString("hex");
    const auth = {
        passwordSalt: salt,
        passwordHash: hashSecret(password, salt),
        tokens: [],
    };
    saveAuthData(auth);
    return issueOwnerToken();
}
function issueOwnerToken() {
    const auth = loadAuthData();
    if (!auth) {
        throw new Error("Password not configured.");
    }
    const token = node_crypto_1.default.randomBytes(32).toString("base64url");
    const salt = node_crypto_1.default.randomBytes(16).toString("hex");
    const timestamp = nowIso();
    auth.tokens.push({
        id: createId(10),
        salt,
        hash: hashSecret(token, salt),
        createdAt: timestamp,
        lastUsedAt: timestamp,
    });
    saveAuthData(auth);
    return token;
}
function verifyOwnerToken(token) {
    const auth = loadAuthData();
    if (!auth) {
        return false;
    }
    let changed = false;
    for (const stored of auth.tokens) {
        if (secureEqualsHex(hashSecret(token, stored.salt), stored.hash)) {
            const lastSeen = Date.parse(stored.lastUsedAt);
            if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 1000 * 60 * 60 * 12) {
                stored.lastUsedAt = nowIso();
                changed = true;
            }
            if (changed) {
                saveAuthData(auth);
            }
            return true;
        }
    }
    return false;
}
function revokeOwnerToken(token) {
    const auth = loadAuthData();
    if (!auth) {
        return;
    }
    const tokens = auth.tokens.filter((stored) => !secureEqualsHex(hashSecret(token, stored.salt), stored.hash));
    if (tokens.length !== auth.tokens.length) {
        auth.tokens = tokens;
        saveAuthData(auth);
    }
}
function parseCookies(header) {
    const cookies = {};
    if (!header) {
        return cookies;
    }
    for (const item of header.split(";")) {
        const index = item.indexOf("=");
        if (index === -1) {
            continue;
        }
        const key = item.slice(0, index).trim();
        const value = item.slice(index + 1).trim();
        cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}
function setCookie(req, res, name, value, options) {
    const secure = req.secure ? "; Secure" : "";
    const httpOnly = options.httpOnly === false ? "" : "; HttpOnly";
    res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${httpOnly}${secure}`);
}
function clearCookie(req, res, name, httpOnly = true) {
    const secure = req.secure ? "; Secure" : "";
    const httpOnlyPart = httpOnly ? "; HttpOnly" : "";
    res.append("Set-Cookie", `${name}=; Path=/; SameSite=Lax; Max-Age=0${httpOnlyPart}${secure}`);
}
function headerValue(value) {
    return Array.isArray(value) ? value[0] : value;
}
function getOwnerSessionTokenFromHeaders(headers) {
    return parseCookies(headerValue(headers.cookie))[ownerSessionCookieName] || null;
}
function getBearerTokenFromHeaders(headers) {
    const header = headerValue(headers.authorization);
    if (!header || !header.startsWith("Bearer ")) {
        return null;
    }
    return header.slice(7).trim() || null;
}
function getOwnerSessionToken(req) {
    return getOwnerSessionTokenFromHeaders(req.headers);
}
function setOwnerSessionCookie(req, res, token) {
    setCookie(req, res, ownerSessionCookieName, token, { maxAgeSeconds: ownerCookieMaxAgeSeconds });
}
function clearOwnerSessionCookie(req, res) {
    clearCookie(req, res, ownerSessionCookieName);
}
function isOwnerAuthenticatedHeaders(headers) {
    const bearer = getBearerTokenFromHeaders(headers);
    if (bearer && verifyApiKey(bearer)) {
        return true;
    }
    const token = getOwnerSessionTokenFromHeaders(headers);
    return Boolean(token && verifyOwnerToken(token));
}
function isOwnerAuthenticated(req) {
    return isOwnerAuthenticatedHeaders(req.headers);
}
function isOwnerAuthenticatedIncomingRequest(req) {
    return isOwnerAuthenticatedHeaders(req.headers);
}
function getBearerToken(req) {
    return getBearerTokenFromHeaders(req.headers);
}
function verifyApiKey(key) {
    const auth = loadAuthData();
    if (!auth || !auth.apiKeys) {
        return false;
    }
    for (const stored of auth.apiKeys) {
        if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
            return true;
        }
    }
    return false;
}
function getApiKeyLabel(key) {
    const auth = loadAuthData();
    if (!auth || !auth.apiKeys) {
        return null;
    }
    for (const stored of auth.apiKeys) {
        if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
            return stored.label;
        }
    }
    return null;
}
function createApiKey(label) {
    const auth = loadAuthData();
    if (!auth) {
        throw new Error("Password not configured.");
    }
    if (!auth.apiKeys) {
        auth.apiKeys = [];
    }
    const rawKey = node_crypto_1.default.randomBytes(32).toString("base64url");
    const salt = node_crypto_1.default.randomBytes(16).toString("hex");
    const apiKey = {
        id: createId(10),
        label: label.trim().slice(0, 80) || "unnamed",
        keySalt: salt,
        keyHash: hashSecret(rawKey, salt),
        createdAt: nowIso(),
    };
    auth.apiKeys.push(apiKey);
    saveAuthData(auth);
    return { id: apiKey.id, label: apiKey.label, key: rawKey, createdAt: apiKey.createdAt };
}
function deleteApiKey(keyId) {
    const auth = loadAuthData();
    if (!auth || !auth.apiKeys) {
        return false;
    }
    const before = auth.apiKeys.length;
    auth.apiKeys = auth.apiKeys.filter((k) => k.id !== keyId);
    if (auth.apiKeys.length !== before) {
        saveAuthData(auth);
        return true;
    }
    return false;
}
function listApiKeys() {
    const auth = loadAuthData();
    if (!auth || !auth.apiKeys) {
        return [];
    }
    return auth.apiKeys.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt }));
}
function getCommenterIdentityFromHeaders(headers) {
    const cookies = parseCookies(headerValue(headers.cookie));
    return {
        id: cookies[commenterIdCookieName] || null,
        name: cookies[commenterNameCookieName] || null,
    };
}
function getCommenterIdentity(req) {
    return getCommenterIdentityFromHeaders(req.headers);
}
function getOrCreateCommenterId(req, res) {
    const existing = getCommenterIdentity(req).id;
    if (existing) {
        return existing;
    }
    const created = node_crypto_1.default.randomBytes(24).toString("base64url");
    setCookie(req, res, commenterIdCookieName, created, { maxAgeSeconds: commenterCookieMaxAgeSeconds });
    return created;
}
function setCommenterNameCookie(req, res, name) {
    setCookie(req, res, commenterNameCookieName, name, { maxAgeSeconds: commenterCookieMaxAgeSeconds });
}
function ensureCommentAuthor(req, res) {
    if (isOwnerAuthenticated(req)) {
        return { authorId: "__owner__", authorName: "Owner" };
    }
    const commenter = getCommenterIdentity(req);
    const name = commenter.name || normalizeCommenterName(String(req.body?.name || ""));
    if (!name) {
        return null;
    }
    const commenterId = commenter.id || getOrCreateCommenterId(req, res);
    return { authorId: commenterId, authorName: name };
}
function canManageMessage(req, message) {
    if (isOwnerAuthenticated(req)) {
        return true;
    }
    const commenter = getCommenterIdentity(req);
    return Boolean(commenter.id && commenter.id === message.authorId);
}
function canManageThread(req, thread) {
    if (isOwnerAuthenticated(req)) {
        return true;
    }
    const commenter = getCommenterIdentity(req);
    return Boolean(commenter.id && thread.messages.some((message) => message.authorId === commenter.id));
}
const VERSION = "0.1.2-skale";
const FOOTER_HTML = `<footer class="app-footer"><a href="https://skale.dev" target="_blank" rel="noopener">skale.dev</a> &middot; v${VERSION}</footer>`;
function renderSimplePage(title, body) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell simple-page">
    <main class="simple-page-content">${body}</main>
    ${FOOTER_HTML}
  </body>
</html>`;
}
function renderAuthPage(mode) {
    const title = mode === "setup" ? "Set password" : "Sign in";
    const heading = mode === "setup" ? "Set the password" : "Enter the password";
    const hint = mode === "setup"
        ? "First startup. This becomes the single owner password for the instance."
        : "This instance uses one password and per-device tokens.";
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell auth-shell" data-auth-mode="${mode}">
    <button type="button" class="text-button theme-toggle auth-theme-toggle" aria-label="Toggle theme"></button>
    <main class="auth-layout">
      <h1>${heading}</h1>
      <p class="auth-hint">${hint}</p>
      <p class="auth-error hidden" id="auth-error"></p>
      <form id="auth-form" class="auth-form">
        <input id="password" name="password" type="password" autocomplete="${mode === "setup" ? "new-password" : "current-password"}" placeholder="Password" minlength="8" required autofocus />
        ${mode === "setup"
        ? '<input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" placeholder="Confirm password" minlength="8" required />'
        : ""}
        <div class="auth-actions">
          <button type="submit">${mode === "setup" ? "Save password" : "Sign in"}</button>
        </div>
      </form>
    </main>
    <script>window.__OWNER_TOKEN_KEY__ = ${JSON.stringify(ownerLocalStorageTokenKey)};</script>
    <script>document.querySelectorAll('.theme-toggle').forEach(function(b){b.innerHTML=window.__themeIcon(document.documentElement.getAttribute('data-theme')||'dark')});</script>
    <script src="/static/login.js" defer></script>
    ${FOOTER_HTML}
  </body>
</html`;
}
function renderAppShell(page, title, data) {
    const attrs = [
        `data-page="${page}"`,
        data?.noteId ? `data-note-id="${escapeHtml(data.noteId)}"` : "",
        data?.shareId ? `data-share-id="${escapeHtml(data.shareId)}"` : "",
        data?.shareAccess ? `data-share-access="${escapeHtml(data.shareAccess)}"` : "",
    ]
        .filter(Boolean)
        .join(" ");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell app-page" ${attrs}>
    <div id="app"></div>
    <script>window.__OWNER_TOKEN_KEY__ = ${JSON.stringify(ownerLocalStorageTokenKey)};</script>
    <script>document.querySelectorAll('.theme-toggle').forEach(function(b){b.innerHTML=window.__themeIcon(document.documentElement.getAttribute('data-theme')||'dark')});</script>
    <script src="/static/components.js"></script>${page !== "list"
        ? `
    <script type="module">
      import mermaid from "/static/mermaid/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: false, theme: document.documentElement.getAttribute("data-theme") === "light" ? "default" : "dark" });
      window.__mermaid = mermaid;
      if (window.__renderMermaid) { var c = document.getElementById("previewContent"); if (c) window.__renderMermaid(c); }
    </script>`
        : ""}
    <script src="/static/app.js" defer></script>
    ${FOOTER_HTML}
  </body>
</html`;
}
