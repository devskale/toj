"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrackedIdList = void 0;
exports.newCollabState = newCollabState;
exports.collabFromMarkdown = collabFromMarkdown;
exports.collabToMarkdown = collabToMarkdown;
exports.saveCollabState = saveCollabState;
exports.loadCollabState = loadCollabState;
exports.idAtIndex = idAtIndex;
exports.idBeforeIndex = idBeforeIndex;
exports.applyClientMutations = applyClientMutations;
const node_crypto_1 = __importDefault(require("node:crypto"));
const articulated_1 = require("articulated");
function charKey(id) {
    return `${id.bunchId}:${id.counter}`;
}
function newCollabState() {
    return {
        idList: articulated_1.IdList.new(),
        chars: new Map(),
        serverCounter: 0,
    };
}
function collabFromMarkdown(markdown, serverCounter = 0) {
    if (!markdown) {
        return {
            idList: articulated_1.IdList.new(),
            chars: new Map(),
            serverCounter,
        };
    }
    const bunchId = node_crypto_1.default.randomUUID();
    const startId = { bunchId, counter: 0 };
    const idList = articulated_1.IdList.new().insertAfter(null, startId, markdown.length);
    const chars = new Map();
    for (let index = 0; index < markdown.length; index++) {
        chars.set(charKey({ bunchId, counter: index }), markdown[index]);
    }
    return { idList, chars, serverCounter };
}
function collabToMarkdown(state) {
    const parts = [];
    for (const id of state.idList.values()) {
        const char = state.chars.get(charKey(id));
        if (char !== undefined) {
            parts.push(char);
        }
    }
    return parts.join("");
}
function saveCollabState(state) {
    const idListState = state.idList.save();
    const chars = [];
    for (const item of idListState) {
        let text = "";
        for (let offset = 0; offset < item.count; offset++) {
            const id = {
                bunchId: item.bunchId,
                counter: item.startCounter + offset,
            };
            text += state.chars.get(charKey(id)) || "\0";
        }
        chars.push({
            bunchId: item.bunchId,
            startCounter: item.startCounter,
            chars: text,
        });
    }
    return {
        idListState,
        chars,
        serverCounter: state.serverCounter,
    };
}
function loadCollabState(saved) {
    const idList = articulated_1.IdList.load(saved.idListState || []);
    const chars = new Map();
    for (const bunch of saved.chars || []) {
        for (let offset = 0; offset < bunch.chars.length; offset++) {
            const id = {
                bunchId: bunch.bunchId,
                counter: bunch.startCounter + offset,
            };
            chars.set(charKey(id), bunch.chars[offset]);
        }
    }
    return {
        idList,
        chars,
        serverCounter: saved.serverCounter || 0,
    };
}
function idAtIndex(state, index) {
    return state.idList.at(index);
}
function idBeforeIndex(state, index) {
    if (index <= 0) {
        return null;
    }
    return state.idList.at(index - 1);
}
class TrackedIdList {
    trackChanges;
    _idList;
    updates = [];
    constructor(idList, trackChanges) {
        this.trackChanges = trackChanges;
        this._idList = idList;
    }
    get idList() {
        return this._idList;
    }
    getAndResetUpdates() {
        if (!this.trackChanges) {
            throw new Error("trackChanges not enabled");
        }
        const updates = this.updates;
        this.updates = [];
        return updates;
    }
    insertAfter(before, newId, count = 1) {
        this._idList = this._idList.insertAfter(before, newId, count);
        if (this.trackChanges) {
            this.updates.push({ type: "insertAfter", before, id: newId, count });
        }
    }
    deleteRange(startIndex, endIndex) {
        const ids = [];
        for (let index = startIndex; index <= endIndex; index++) {
            ids.push(this._idList.at(index));
        }
        for (const id of ids) {
            this._idList = this._idList.delete(id);
        }
        if (this.trackChanges) {
            this.updates.push({ type: "deleteRange", startIndex, endIndex });
        }
    }
    apply(update) {
        switch (update.type) {
            case "insertAfter":
                this._idList = this._idList.insertAfter(update.before, update.id, update.count);
                return;
            case "deleteRange":
                this.deleteRange(update.startIndex, update.endIndex);
                if (!this.trackChanges) {
                    return;
                }
                this.updates.pop();
                return;
        }
    }
}
exports.TrackedIdList = TrackedIdList;
function applyInsertMutation(trackedIds, chars, mutation) {
    const { before, id, content, isInWord } = mutation.args;
    if (!content) {
        return;
    }
    if (before !== null && !trackedIds.idList.isKnown(before)) {
        return;
    }
    if (trackedIds.idList.isKnown(id)) {
        return;
    }
    if (isInWord && before !== null && !trackedIds.idList.has(before)) {
        return;
    }
    trackedIds.insertAfter(before, id, content.length);
    for (let offset = 0; offset < content.length; offset++) {
        chars.set(charKey({ bunchId: id.bunchId, counter: id.counter + offset }), content[offset]);
    }
}
function applyDeleteMutation(trackedIds, mutation) {
    const { startId, endId, contentLength } = mutation.args;
    if (!trackedIds.idList.isKnown(startId)) {
        return;
    }
    const startIndex = trackedIds.idList.indexOf(startId, "right");
    const endIndex = endId === undefined
        ? startIndex
        : trackedIds.idList.isKnown(endId)
            ? trackedIds.idList.indexOf(endId, "left")
            : startIndex - 1;
    if (endIndex < startIndex) {
        return;
    }
    const currentLength = endIndex - startIndex + 1;
    if (contentLength !== undefined && currentLength > contentLength + 10) {
        return;
    }
    trackedIds.deleteRange(startIndex, endIndex);
}
function applyClientMutations(state, mutations) {
    const trackedIds = new TrackedIdList(state.idList, true);
    const chars = new Map(state.chars);
    for (const mutation of mutations) {
        switch (mutation.name) {
            case "insert":
                applyInsertMutation(trackedIds, chars, mutation);
                break;
            case "delete":
                applyDeleteMutation(trackedIds, mutation);
                break;
        }
    }
    const idListUpdates = trackedIds.getAndResetUpdates();
    const nextState = {
        idList: trackedIds.idList,
        chars,
        serverCounter: idListUpdates.length > 0 ? state.serverCounter + 1 : state.serverCounter,
    };
    return {
        state: nextState,
        markdown: collabToMarkdown(nextState),
        idListUpdates,
        changed: idListUpdates.length > 0,
    };
}
