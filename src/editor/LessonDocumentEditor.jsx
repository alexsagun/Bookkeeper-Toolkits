// ─────────────────────────────────────────────────────────────────────────────
// src/editor/LessonDocumentEditor.jsx — the lesson instructions canvas.
//
// ★ THIS FILE IS A SANCTIONED EXCEPTION TO THE SINGLE-FILE RULE, AND A NARROW ONE.
//   It holds the editor SCHEMA, the React wrapper and the node views. Every piece of
//   product behaviour — uploading, the Supabase RPCs, the save gate, the orphan sweep,
//   the error copy — stays in src/BookkeeperPro.jsx and arrives here as a prop. There is
//   no Supabase import in this file and there must never be one.
//
// ★ IT ALSO IMPORTS NOTHING FROM BookkeeperPro.jsx, AND THAT IS LOAD-BEARING.
//   The whole point of this module is that it is lazy-loaded: ~120 KB of ProseMirror for
//   the handful of people who can edit a course, not for every student reading one. One
//   import of the design-token object `C` would pull the 37k-line monolith into this
//   chunk and undo that completely. So everything here is styled with CSS classes over
//   the `var(--…)` tokens in src/index.css.
//
// ★ WHY A CONTENTEDITABLE EDITOR IS SAFE HERE, WHEN A HAND-ROLLED ONE WOULD NOT BE.
//   The objection this feature was built around is real: accepting HTML from the DOM and
//   sanitizing it back into a safe subset is a losing position. ProseMirror is not that.
//   The SCHEMA below is an allowlist — a node or mark it does not declare cannot exist in
//   the document, so pasted markup is dropped rather than filtered. Nothing HTML-shaped
//   is ever persisted: the document is serialized by src/lib/lessonDocument.js back into
//   the same closed markdown subset, which is then checked by the same
//   validateLessonContent and rendered to students by the same LessonRichText. Three
//   independent layers, and the stored bytes are byte-compatible with what shipped
//   before this editor existed.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext, useCallback, useContext, useEffect, useImperativeHandle,
  useMemo, useRef, useState,
} from 'react';
import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Bold from '@tiptap/extension-bold';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import {
  AlertTriangle, Bold as BoldIcon, ImagePlus, Link2, List, ListOrdered,
  Loader2, Redo2, RefreshCw, Trash2, Undo2, X,
} from 'lucide-react';

import {
  LESSON_IMAGE_ACCEPT, LESSON_IMAGE_ALT_MAX, LESSON_IMAGE_CAPTION_MAX,
  safeLessonHref, sanitizeAltText, sanitizeCaption, validateLessonImageFile,
} from '../lib/lessonContent.js';
import { docToMarkdown, markdownToDoc } from '../lib/lessonDocument.js';

/** What a creator is told when a picture arrives by reference instead of by value. */
export const REMOTE_IMAGE_NOTICE =
  'The text was pasted. The picture in it was not: it is hosted on another website. '
  + 'A linked image would break when that site changes it, and would tell that site who '
  + 'is reading your lesson. Save the picture to your computer, then use the Image button.';

const AssetContext = createContext({
  urls: {}, onRetry: null, onCancel: null, onReplace: null, onNotice: null, readOnly: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// The schema — an allowlist, mirroring LESSON_DOC_NODES / LESSON_DOC_MARKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A link whose address this app will not render.
 *
 * ★ safeLessonHref IS THE ONLY SCHEME AUTHORITY, on the way in as well as on the way
 *   out. @tiptap/extension-link is deliberately NOT used: it brings linkifyjs, whose idea
 *   of a URL is not this app's, and a second opinion about what counts as a safe address
 *   is exactly the thing that lets a `javascript:` URL through one door while the other
 *   is locked. Returning false from getAttrs REFUSES the mark, so a pasted unsafe link
 *   keeps its words and loses its address.
 */
const LessonLink = Mark.create({
  name: 'link',
  priority: 1000,
  keepOnSplit: false,
  inclusive: false, // typing after a link must not extend it
  addAttributes() {
    return {
      href: { default: '' },
      bare: { default: false, rendered: false },
    };
  },
  parseHTML() {
    return [{
      tag: 'a[href]',
      getAttrs: (el) => {
        const verdict = safeLessonHref(el.getAttribute('href'));
        return ['external', 'internal', 'fragment'].includes(verdict.kind)
          ? { href: verdict.href, bare: false }
          : false;
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    // rel is not negotiable: an editor preview still opens in a real browser tab.
    return ['a', mergeAttributes(HTMLAttributes, {
      rel: 'noopener noreferrer', target: '_blank', class: 'lesson-doc-link',
    }), 0];
  },
});

/** An image that lives in the private bucket. Addressed ONLY by its asset id. */
const LessonImage = Node.create({
  name: 'lessonImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { assetId: { default: '' }, alt: { default: '' }, caption: { default: '' } };
  },
  // ★ NO parseHTML RULE, ON PURPOSE. Nothing in a pasted document — least of all an
  //   <img> — may become one of these. An image gets in by being uploaded, and only then.
  parseHTML() { return []; },
  renderHTML() { return ['div', { 'data-lesson-image': '' }]; },
  addNodeView() { return ReactNodeViewRenderer(LessonImageView); },
});

/** A transfer in progress. Never serialized — see normalizeBlocks in lessonDocument.js. */
const UploadingImage = Node.create({
  name: 'uploadingImage',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      uploadKey: { default: '' },
      previewUrl: { default: '' },
      fileName: { default: '' },
      status: { default: 'uploading' }, // uploading | error
      message: { default: '' },
    };
  },
  parseHTML() { return []; },
  renderHTML() { return ['div', { 'data-uploading-image': '' }]; },
  addNodeView() { return ReactNodeViewRenderer(UploadingImageView); },
});

/**
 * A token this model cannot represent, carried verbatim.
 *
 * Reachable only from a hand-edited database row — validateLessonContent refuses to save
 * any of them — which is precisely why it exists. An editor that quietly "repaired" such
 * a lesson would rewrite stored content while showing the creator something else.
 */
const BrokenToken = Node.create({
  name: 'brokenToken',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { raw: { default: '' } }; },
  parseHTML() { return []; },
  renderHTML({ node }) {
    return ['span', { class: 'lesson-doc-broken', title: 'This is shown exactly as it is stored' },
      node.attrs.raw];
  },
});

/**
 * Tab must LEAVE the editor, never indent inside it.
 *
 * ListItem binds Tab/Shift-Tab to sink/lift by default. Nesting is unrepresentable here
 * (listItem holds exactly one paragraph), so those would be a keyboard trap that does
 * nothing — WCAG 2.1.2. Returning false leaves the event unhandled, so the browser moves
 * focus the way it does everywhere else.
 */
const FlatListItem = ListItem.extend({
  content: 'paragraph',
  addKeyboardShortcuts() { return { Tab: () => false, 'Shift-Tab': () => false }; },
});

/** Ctrl/Cmd+K, routed through a ref so the binding never closes over stale state. */
const createShortcuts = (handlersRef) => Extension.create({
  name: 'lessonShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => { handlersRef.current?.openLink?.(); return true; },
      // Tab is not bound here: the whole surface must stay escapable by keyboard.
    };
  },
});

export const buildLessonExtensions = (handlersRef, placeholder) => [
  Document, Paragraph, Text, HardBreak, Bold,
  BulletList, OrderedList, FlatListItem,
  LessonLink, LessonImage, UploadingImage, BrokenToken,
  UndoRedo, Dropcursor, Gapcursor,
  Placeholder.configure({ placeholder: placeholder || 'Write the lesson instructions…' }),
  createShortcuts(handlersRef),
];

// ─────────────────────────────────────────────────────────────────────────────
// Node views
// ─────────────────────────────────────────────────────────────────────────────

function LessonImageView({ node, updateAttributes, deleteNode, selected, editor }) {
  const { urls, onReplace, onNotice, readOnly } = useContext(AssetContext);
  // ★ ANY CONTROL THAT UNMOUNTS ITSELF MUST HAND FOCUS BACK. Closing a panel, or removing
  //   an image, deletes the element that HAS focus, and a browser then moves focus to
  //   <body> — outside a dialog that claims aria-modal. SidePanel's trap only acts at its
  //   first/last element, so it cannot recover it: the next Tab walks the page behind the
  //   scrim. The link bar already did this; these paths did not.
  const restoreFocus = () => requestAnimationFrame(() => {
    if (editor && !editor.isDestroyed) editor.chain().focus().run();
  });
  const { assetId, alt, caption } = node.attrs;
  const url = urls[assetId];
  const [panel, setPanel] = useState(null); // 'alt' | 'caption' | null
  const [swapping, setSwapping] = useState(false);
  const altRef = useRef(null);
  const capRef = useRef(null);
  const replaceRef = useRef(null);
  const needsAlt = !sanitizeAltText(alt);

  /**
   * Swap the picture, keep the words.
   *
   * The description and the caption are about what the image SHOWS, and a replacement is
   * almost always a fresh capture of the same thing — so they stay.
   *
   * ★ THE OLD ASSET IS NOT DELETED HERE, AND NEITHER IS A REMOVED ONE. Deleting on the
   *   click destroyed the row and the bytes immediately — and `UndoRedo` is in this
   *   schema, so one Ctrl+Z brought the node back pointing at an asset that no longer
   *   existed. `validateLessonContent` cannot see that, so the save reached the trigger
   *   and died on LESSON_ASSET_UNKNOWN_REF with the picture still on screen and no way out
   *   but finding and deleting that node by hand. The same click also killed a SECOND copy
   *   of the same image elsewhere in the lesson, which the format explicitly allows.
   *   What survives is decided by what the SAVED text cites — that is what
   *   sweepLessonAssetOrphans is for, and it runs on save and on close.
   */
  const onPickReplacement = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onReplace) return;
    setSwapping(true);
    let res;
    try { res = await onReplace(file); } finally { setSwapping(false); }
    if (res && res.ok && res.assetId) {
      updateAttributes({ assetId: res.assetId });
    } else {
      onNotice?.((res && res.message) || 'That image could not be uploaded.');
    }
  };

  // The alt panel opens on a freshly placed image: a description asked for later is a
  // description never written. Keyed on the id so it fires once per image.
  const announced = useRef('');
  const [focusPanel, setFocusPanel] = useState(false);

  useEffect(() => {
    if (readOnly || !assetId || announced.current === assetId) return;
    announced.current = assetId;
    if (!needsAlt) return;
    // ★ OPENING THE PANEL IS NOT THE SAME AS TAKING THE CARET, AND THIS FIRES
    //   ASYNCHRONOUSLY. An image becomes real when its UPLOAD finishes — seconds later,
    //   by which time the creator has moved on and is writing the next paragraph. Focusing
    //   here yanked the caret out mid-sentence and the rest of it went into the alt field;
    //   with several images pasted at once each completion stole it again. That is WCAG
    //   3.2.2, focus moved by something the user did not initiate. So: always OPEN it —
    //   the request for a description must not be missable — but take focus only when
    //   nothing else already has it.
    const busy = (editor && !editor.isDestroyed && editor.isFocused)
      || (typeof document !== 'undefined' && document.activeElement
        && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    setPanel('alt');
    setFocusPanel(!busy);
  }, [assetId, needsAlt, readOnly, editor]);

  useEffect(() => {
    if (!panel || !focusPanel) return;
    if (panel === 'alt') altRef.current?.focus();
    if (panel === 'caption') capRef.current?.focus();
    setFocusPanel(false);
  }, [panel, focusPanel]);

  /** Opened deliberately, so it takes focus — unlike the automatic open above. */
  const togglePanel = (which) => {
    setPanel((p) => {
      if (p === which) { restoreFocus(); return null; }
      return which;
    });
    setFocusPanel(true);
  };

  const closePanel = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    setPanel(null);
    restoreFocus();
  };

  return (
    <NodeViewWrapper
      className={`lesson-doc-figure${selected ? ' is-selected' : ''}${needsAlt ? ' needs-alt' : ''}`}
      data-drag-handle
    >
      <figure className="lesson-doc-figure-inner">
        {url === undefined && (
          <div className="lesson-doc-image-state" role="status">
            <Loader2 size={16} className="motion-reduce:animate-none animate-spin" aria-hidden="true" />
            <span>Loading image…</span>
          </div>
        )}
        {url === null && (
          <div className="lesson-doc-image-state is-bad" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>This image could not be loaded.</span>
          </div>
        )}
        {typeof url === 'string' && url && (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={url} alt={alt || 'Image with no description yet'} className="lesson-doc-image" draggable={false} />
        )}
        {needsAlt && !readOnly && (
          <span className="lesson-doc-badge">Needs description</span>
        )}
        {caption ? <figcaption className="lesson-doc-caption">{caption}</figcaption> : null}
      </figure>

      {!readOnly && (
        <div className="lesson-doc-figure-bar" contentEditable={false}>
          <button type="button" className="lesson-doc-chip" onClick={() => togglePanel('alt')}
            aria-expanded={panel === 'alt'}>
            {needsAlt ? 'Add description' : 'Description'}
          </button>
          <button type="button" className="lesson-doc-chip" onClick={() => togglePanel('caption')}
            aria-expanded={panel === 'caption'}>
            {caption ? 'Caption' : 'Add caption'}
          </button>
          <button type="button" className="lesson-doc-chip" disabled={swapping}
            onClick={() => replaceRef.current?.click()}
            title="Upload a different picture, keeping this description">
            {swapping
              ? <><Loader2 size={12} className="motion-reduce:animate-none animate-spin" aria-hidden="true" /> Replacing…</>
              : <><RefreshCw size={12} aria-hidden="true" /> Replace</>}
          </button>
          <button type="button" className="lesson-doc-chip is-danger"
            onClick={() => { deleteNode(); restoreFocus(); }}>
            <Trash2 size={12} aria-hidden="true" /> Remove
          </button>
          <input ref={replaceRef} type="file" accept={LESSON_IMAGE_ACCEPT} className="hidden"
            aria-label="Choose a replacement image" onChange={onPickReplacement} />
        </div>
      )}

      {panel && !readOnly && (
        // Escape dismisses THIS panel and must not reach the drawer: SidePanel listens on
        // window, so without stopPropagation it would close the whole lesson editor and
        // ask whether to discard the draft.
        <div className="lesson-doc-figure-panel" contentEditable={false}
          onKeyDown={(e) => { if (e.key === 'Escape') closePanel(e); }}>
          {panel === 'alt' ? (
            <label className="lesson-doc-field">
              <span className="lesson-doc-field-label">
                Describe this image <span aria-hidden="true" className="lesson-doc-req">*</span>
              </span>
              <input
                ref={altRef} value={alt || ''} maxLength={LESSON_IMAGE_ALT_MAX}
                required aria-required="true" aria-invalid={needsAlt || undefined}
                aria-describedby={`lesson-doc-alt-why-${assetId}`}
                placeholder="Google Form menu showing the three-dot button"
                onChange={(e) => updateAttributes({ alt: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') closePanel(e); }}
                className="lesson-doc-input"
              />
              <span id={`lesson-doc-alt-why-${assetId}`} className="lesson-doc-hint">
                Read aloud to students using a screen reader, and shown if the image cannot load.
              </span>
            </label>
          ) : (
            // A caption is NOT the alt text: one is announced, the other is printed. Using
            // one as the other makes a screen reader read the same sentence twice.
            <label className="lesson-doc-field">
              <span className="lesson-doc-field-label">Caption (optional)</span>
              <input
                ref={capRef} value={caption || ''} maxLength={LESSON_IMAGE_CAPTION_MAX}
                placeholder="Figure 1 — the three-dot button"
                aria-describedby={`lesson-doc-cap-why-${assetId}`}
                onChange={(e) => updateAttributes({ caption: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') closePanel(e); }}
                className="lesson-doc-input"
              />
              <span id={`lesson-doc-cap-why-${assetId}`} className="lesson-doc-hint">
                Printed under the picture for everyone to read.
              </span>
            </label>
          )}
          <button type="button" className="lesson-doc-chip" onClick={closePanel}>Done</button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

function UploadingImageView({ node, deleteNode, editor }) {
  const { onRetry, onCancel } = useContext(AssetContext);
  const { previewUrl, fileName, status, message, uploadKey } = node.attrs;
  const failed = status === 'error';
  // ★ A FAILED UPLOAD THAT IS THEN REMOVED LEAKS UNLESS SOMEONE SAYS SO. failUpload keeps
  //   the File and its object URL alive on purpose, so Retry can use them — but the only
  //   things that release them are settleUpload and failUpload, and neither will ever run
  //   again for a node that no longer exists. Ten dismissed 10 MB screenshots stayed
  //   pinned for the life of the drawer.
  const drop = () => {
    deleteNode();
    onCancel?.(uploadKey);
    requestAnimationFrame(() => { if (editor && !editor.isDestroyed) editor.chain().focus().run(); });
  };
  return (
    <NodeViewWrapper className={`lesson-doc-figure is-pending${failed ? ' is-failed' : ''}`}>
      <div className="lesson-doc-figure-inner" contentEditable={false}>
        {previewUrl
          ? <img src={previewUrl} alt="" className="lesson-doc-image is-dim" draggable={false} />
          : <div className="lesson-doc-image-state"><ImagePlus size={16} aria-hidden="true" /></div>}
        <div className="lesson-doc-pending-bar" role="status">
          {failed
            ? <><AlertTriangle size={13} aria-hidden="true" /><span>{message || 'Upload failed.'}</span></>
            : <><Loader2 size={13} className="motion-reduce:animate-none animate-spin" aria-hidden="true" />
              <span>Uploading {fileName || 'image'}…</span></>}
        </div>
        {/* Indeterminate on purpose: supabase-js exposes no progress for an upload, and a
            bar that invents a percentage is worse than one that admits it does not know. */}
        {!failed && <div className="lesson-doc-progress"><div className="lesson-doc-progress-bar" /></div>}
      </div>
      <div className="lesson-doc-figure-bar" contentEditable={false}>
        {failed && (
          <button type="button" className="lesson-doc-chip" onClick={() => onRetry?.(uploadKey)}>
            <RefreshCw size={12} aria-hidden="true" /> Retry
          </button>
        )}
        <button type="button" className="lesson-doc-chip is-danger" onClick={drop}>
          {failed ? 'Remove' : 'Cancel'}
        </button>
      </div>
    </NodeViewWrapper>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ `softDisabled` IS aria-disabled, NEVER `disabled`, AND THAT DISTINCTION IS THE POINT.
 *   A browser blurs a focused element the instant it becomes disabled, so pressing Redo
 *   until the stack empties threw a keyboard user out to <body> — inside an aria-modal
 *   dialog, where SidePanel's Tab trap cannot recover them (it only acts when the active
 *   element is first, last or the panel), so Tab then walked the page behind the scrim.
 *   This is verbatim the defect CLAUDE.md records for the sidebar Move up/Move down
 *   buttons. Real `disabled` stays correct for the whole-toolbar case, which is driven by
 *   a save the user is waiting on rather than by the button under their finger.
 */
const ToolButton = ({ onClick, active, expanded, disabled, softDisabled, label, title, children }) => (
  <button
    type="button" onClick={softDisabled ? undefined : onClick} disabled={disabled} title={title || label}
    aria-disabled={softDisabled ? true : undefined}
    aria-label={label} aria-pressed={active === undefined ? undefined : !!active}
    aria-expanded={expanded === undefined ? undefined : !!expanded}
    className={`lesson-doc-tool${active ? ' is-active' : ''}${softDisabled ? ' is-off' : ''}`}
  >
    {children}
  </button>
);

/**
 * @param {object}   props
 * @param {string}   props.initialMarkdown  text_content as stored
 * @param {string}   props.initialFormat    content_format ('plain' | 'markdown')
 * @param {object}   props.assetUrls        { [assetId]: string | null | undefined }
 * @param {Function} props.onChange         (markdown) => void — fires on every edit
 * @param {Function} props.uploadImage      async (file) => { ok, assetId } | { ok:false, message }
 * @param {Function} props.onNotice         (message) => void — paste refusals, limits
 * @param {Function} props.canAddImages     (count) => string|null — refusal message, or null
 */
const LessonDocumentEditor = React.forwardRef(function LessonDocumentEditor({
  initialMarkdown = '', initialFormat = 'plain', assetUrls = {},
  onChange, uploadImage, onNotice, canAddImages,
  disabled = false, placeholder = '', labelledBy = undefined,
}, ref) {
  const handlersRef = useRef({});
  const lastSerializedRef = useRef(null);
  const fileInputRef = useRef(null);
  const pendingFilesRef = useRef(new Map()); // uploadKey -> { file, previewUrl }
  const objectUrlsRef = useRef(new Set());
  const [linkBar, setLinkBar] = useState(null);
  const linkUrlRef = useRef(null);

  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(uploadImage);
  const noticeRef = useRef(onNotice);
  const canAddRef = useRef(canAddImages);
  useEffect(() => {
    onChangeRef.current = onChange; uploadRef.current = uploadImage;
    noticeRef.current = onNotice; canAddRef.current = canAddImages;
  });

  const initialDoc = useMemo(
    () => markdownToDoc(initialMarkdown, initialFormat),
    // Mount-only on purpose: re-deriving the document from the prop on every render is
    // the reset loop that destroys the caret and the undo history. The parent keys this
    // component on the lesson id, so a different lesson is a different instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const extensions = useMemo(() => buildLessonExtensions(handlersRef, placeholder), [placeholder]);

  const emitTimerRef = useRef(null);
  /** Tell the parent what the document says now, if it has actually changed. */
  const emitNow = useCallback((ed) => {
    if (!ed || ed.isDestroyed) return;
    const md = docToMarkdown(ed.getJSON());
    // ★ ONE DIRECTION ONLY. The parent is told what changed; nothing it does with that
    //   comes back in here. Skipping an unchanged serialization also keeps a pure
    //   selection change from marking the draft dirty.
    if (md === lastSerializedRef.current) return;
    lastSerializedRef.current = md;
    onChangeRef.current?.(md);
  }, []);
  const flushEmit = useCallback((ed) => {
    if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = null; }
    emitNow(ed);
  }, [emitNow]);
  const scheduleEmit = useCallback((ed) => {
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    emitTimerRef.current = setTimeout(() => { emitTimerRef.current = null; emitNow(ed); }, 180);
  }, [emitNow]);

  const editor = useEditor({
    extensions,
    content: initialDoc,
    editable: !disabled,
    // ★ @tiptap/react 3 DEFAULTS THIS OFF, and without it the toolbar lies. is-active and
    //   aria-pressed are derived from editor.isActive(...), but the component only
    //   re-rendered when the SERIALIZED TEXT changed — so moving the caret into a bold
    //   word left Bold looking inactive and announcing "not pressed", and pressing Bold on
    //   a collapsed caret (which sets a stored mark and changes no text) lit nothing at
    //   all, so the creator pressed it again and turned it back off.
    shouldRerenderOnTransaction: true,
    editorProps: {
      // The visible label is the accessible name, so the two cannot say different things.
      attributes: {
        class: 'lesson-doc-surface', role: 'textbox', 'aria-multiline': 'true',
        ...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': 'Lesson instructions' }),
      },
      handlePaste: (view, event) => handlePaste(event),
      handleDrop: (view, event) => handleDrop(event),
    },
    // ★ DEBOUNCED, AND THE FLUSH POINTS ARE WHAT MAKE THAT SAFE. Serializing is ~6 ms on a
    //   full-size 20 000-character lesson even with the block cache, and the parent then
    //   does two JSON.stringify dirty checks and a synchronous localStorage write of the
    //   whole draft. Doing all of that per keystroke is visible lag. The parent must still
    //   never read a stale document, so: flush on blur (clicking Cancel or Save blurs the
    //   canvas first), flush on unmount, and saveLesson reads getMarkdown() directly.
    onUpdate: ({ editor: ed }) => { scheduleEmit(ed); },
    onBlur: ({ editor: ed }) => { flushEmit(ed); },
  }, []);

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [editor, disabled]);

  // Object URLs are revoked when their placeholder goes, and again on unmount — a preview
  // of a 10 MB screenshot held after the drawer closes is a leak nobody would notice.
  useEffect(() => () => {
    objectUrlsRef.current.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* best effort */ } });
    objectUrlsRef.current.clear();
  }, []);

  const findUpload = useCallback((uploadKey) => {
    // ★ isDestroyed, not just null. closeLessonEditor deliberately does NOT wait for an
    //   image upload, so a transfer regularly settles after ProseMirror has torn the view
    //   down — and dispatching there throws inside a catch that then throws again, as an
    //   unhandled rejection with no user-visible cause.
    if (!editor || editor.isDestroyed) return null;
    let found = null;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'uploadingImage' && node.attrs.uploadKey === uploadKey) found = { node, pos };
      return true;
    });
    return found;
  }, [editor]);

  const releasePreview = useCallback((uploadKey) => {
    const entry = pendingFilesRef.current.get(uploadKey);
    if (entry?.previewUrl) {
      try { URL.revokeObjectURL(entry.previewUrl); } catch { /* best effort */ }
      objectUrlsRef.current.delete(entry.previewUrl);
    }
  }, []);

  /**
   * ★ THE PLACEHOLDER IS FOUND BY ITS KEY AT COMMIT TIME, NOT BY A REMEMBERED POSITION.
   *   An upload takes seconds and the creator keeps typing, so a position captured when
   *   the transfer started points somewhere else by the time it finishes. Looking the
   *   node up by attribute means the picture lands where it was put, or — if the creator
   *   deleted the placeholder meanwhile — nowhere at all, which is what they asked for.
   */
  const settleUpload = useCallback((uploadKey, assetId) => {
    const at = findUpload(uploadKey);
    // No placeholder means the creator deleted it while the bytes were moving. Respect
    // that: the parent's orphan sweep collects the object, and nothing reappears under a
    // caret that has moved on.
    if (!at) { releasePreview(uploadKey); pendingFilesRef.current.delete(uploadKey); return false; }
    const { state, view } = editor;
    view.dispatch(state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize,
      state.schema.nodes.lessonImage.create({ assetId, alt: '', caption: '' })));
    releasePreview(uploadKey);
    pendingFilesRef.current.delete(uploadKey);
    return true;
  }, [editor, findUpload, releasePreview]);

  const failUpload = useCallback((uploadKey, message) => {
    const at = findUpload(uploadKey);
    if (!at) { releasePreview(uploadKey); pendingFilesRef.current.delete(uploadKey); return; }
    const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, {
      ...at.node.attrs, status: 'error', message: message || 'Upload failed.',
    });
    editor.view.dispatch(tr);
  }, [editor, findUpload, releasePreview]);

  const runUpload = useCallback(async (uploadKey) => {
    const entry = pendingFilesRef.current.get(uploadKey);
    if (!entry || !uploadRef.current) return;
    const at = findUpload(uploadKey);
    if (at && at.node.attrs.status === 'error') {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(at.pos, undefined,
        { ...at.node.attrs, status: 'uploading', message: '' }));
    }
    try {
      const res = await uploadRef.current(entry.file);
      if (res && res.ok && res.assetId) settleUpload(uploadKey, res.assetId);
      else failUpload(uploadKey, (res && res.message) || 'Upload failed.');
    } catch (e) {
      failUpload(uploadKey, (e && e.message) || 'Upload failed.');
    }
  }, [editor, findUpload, settleUpload, failUpload]);

  const addFiles = useCallback((files) => {
    if (!editor || disabled) return;
    const all = Array.from(files || []).filter(Boolean);
    if (!all.length) return;
    // ★ REFUSE BEFORE A PLACEHOLDER EXISTS. The parent validates again before it uploads,
    //   but doing it here too means an SVG or a 40 MB file never becomes a card the creator
    //   has to watch fail — and never mints an object URL nobody will revoke.
    const list = [];
    for (const file of all) {
      const verdict = validateLessonImageFile(file);
      if (verdict.ok) list.push(file);
      else noticeRef.current?.(verdict.message);
    }
    if (!list.length) return;
    const refusal = canAddRef.current?.(list.length);
    if (refusal) { noticeRef.current?.(refusal); return; }

    const nodes = [];
    for (const file of list) {
      const uploadKey = `up-${Math.random().toString(36).slice(2)}-${nodes.length}`;
      let previewUrl = '';
      try { previewUrl = URL.createObjectURL(file); objectUrlsRef.current.add(previewUrl); } catch { previewUrl = ''; }
      pendingFilesRef.current.set(uploadKey, { file, previewUrl });
      nodes.push(editor.state.schema.nodes.uploadingImage.create({
        uploadKey, previewUrl, fileName: file.name || 'image', status: 'uploading', message: '',
      }));
    }
    // Inserted AT THE CARET, which is the whole point of the change: an image appears
    // where it was put, not in a list underneath the editor.
    editor.chain().focus().insertContent(nodes.map((n) => n.toJSON())).run();
    nodes.forEach((n) => runUpload(n.attrs.uploadKey));
  }, [editor, disabled, runUpload]);

  /**
   * ★ FILES FIRST, AND RETURN TRUE — one screenshot is on the clipboard as BOTH a file
   *   and an HTML fragment, so handling the file without claiming the event would insert
   *   it twice.
   * ★ FOR THE HTML FLAVOUR, DO NOT preventDefault. The schema has no rule that turns an
   *   <img> into anything, so ProseMirror drops it and keeps the prose around it.
   *   Cancelling the paste instead would throw away the paragraph the creator wanted —
   *   which is exactly the bug the textarea version had to fix.
   */
  const handlePaste = useCallback((event) => {
    const dt = event.clipboardData;
    if (!dt || disabled) return false;
    const files = Array.from(dt.files || []).filter((f) => /^image\//i.test(f.type || ''));
    if (files.length) { event.preventDefault(); addFiles(files); return true; }
    const html = dt.getData ? (dt.getData('text/html') || '') : '';
    if (/<img\b/i.test(html)) noticeRef.current?.(REMOTE_IMAGE_NOTICE);
    return false;
  }, [addFiles, disabled]);

  const handleDrop = useCallback((event) => {
    const dt = event.dataTransfer;
    if (!dt || disabled) return false;
    const files = Array.from(dt.files || []).filter((f) => /^image\//i.test(f.type || ''));
    if (!files.length) return false;
    event.preventDefault();
    addFiles(files);
    return true;
  }, [addFiles, disabled]);

  // ── link bar ──────────────────────────────────────────────────────────────
  const openLink = useCallback(() => {
    if (!editor || disabled) return;
    const existing = editor.getAttributes('link');
    const { from, to, empty } = editor.state.selection;
    const selected = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
    setLinkBar({
      href: existing.href || '',
      text: selected || (existing.href ? editor.state.doc.textBetween(...linkRange(editor), ' ') : ''),
      editing: !!existing.href,
      error: '',
    });
    requestAnimationFrame(() => linkUrlRef.current?.select());
  }, [editor, disabled]);

  useEffect(() => { handlersRef.current = { openLink }; }, [openLink]);

  const closeLink = useCallback((e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    setLinkBar(null);
    editor?.chain().focus().run();
  }, [editor]);

  const confirmLink = useCallback(() => {
    if (!editor || !linkBar) return;
    const verdict = safeLessonHref(linkBar.href);
    if (!['external', 'internal', 'fragment'].includes(verdict.kind)) {
      setLinkBar((b) => ({
        ...b,
        error: verdict.reason === 'insecure'
          ? 'Links must start with https:// — an http:// link is not secure.'
          : 'That is not a valid https:// address.',
      }));
      return;
    }
    const words = (linkBar.text || '').trim();
    const chain = editor.chain().focus();
    if (linkBar.editing) chain.extendMarkRange('link');
    if (editor.state.selection.empty && !linkBar.editing) {
      chain.insertContent({
        type: 'text', text: words || verdict.host || verdict.href,
        marks: [{ type: 'link', attrs: { href: verdict.href, bare: false } }],
      });
    } else if (words && words !== editor.state.doc.textBetween(...linkRange(editor), ' ')) {
      chain.insertContent({
        type: 'text', text: words,
        marks: [{ type: 'link', attrs: { href: verdict.href, bare: false } }],
      });
    } else {
      chain.setMark('link', { href: verdict.href, bare: false });
    }
    chain.run();
    setLinkBar(null);
  }, [editor, linkBar]);

  const removeLink = useCallback(() => {
    editor?.chain().focus().extendMarkRange('link').unsetMark('link').run();
    setLinkBar(null);
  }, [editor]);

  // A pending emit must not be lost when the drawer closes or the lesson changes.
  useEffect(() => () => { if (emitTimerRef.current) clearTimeout(emitTimerRef.current); }, []);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.chain().focus().run(),
    // Reads the LIVE document, so a save never races the debounce above.
    getMarkdown: () => (editor && !editor.isDestroyed ? docToMarkdown(editor.getJSON()) : ''),
    flush: () => flushEmit(editor),
    focusImage: (assetId) => {
      if (!editor) return false;
      let pos = null;
      editor.state.doc.descendants((node, p) => {
        if (pos !== null) return false;
        if (node.type.name === 'lessonImage' && node.attrs.assetId === assetId) pos = p;
        return true;
      });
      if (pos === null) return false;
      editor.chain().focus().setNodeSelection(pos).run();
      // ★ ProseMirror applies .ProseMirror-selectednode SYNCHRONOUSLY; .is-selected is a
      //   React prop delivered on a later render, so querying it here found nothing (no
      //   scroll at all) or the PREVIOUSLY selected figure — while still reporting true,
      //   which suppressed the caller's fallback. A refused save then pointed nowhere.
      const at = editor.view.dom.querySelector('.ProseMirror-selectednode');
      at?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
  }), [editor, flushEmit]);

  const assetCtx = useMemo(() => ({
    urls: assetUrls,
    onRetry: runUpload,
    // Replacing is net-zero on the per-lesson image count, so it does not ask canAddImages.
    onCancel: (uploadKey) => { releasePreview(uploadKey); pendingFilesRef.current.delete(uploadKey); },
    onReplace: async (file) => {
      if (!uploadRef.current) return { ok: false, message: 'Uploading is not available.' };
      const verdict = validateLessonImageFile(file);
      if (!verdict.ok) return { ok: false, message: verdict.message };
      return uploadRef.current(file);
    },
    onNotice: (m) => noticeRef.current?.(m),
    readOnly: disabled,
  }), [assetUrls, runUpload, releasePreview, disabled]);

  if (!editor) {
    return (
      <div className="lesson-doc-shell" aria-busy="true">
        <div className="lesson-doc-loading" role="status">
          <Loader2 size={15} className="motion-reduce:animate-none animate-spin" aria-hidden="true" />
          <span>Loading the editor…</span>
        </div>
      </div>
    );
  }

  const act = (fn) => () => { fn(editor.chain().focus()).run(); };

  return (
    <AssetContext.Provider value={assetCtx}>
      {/* Escape belongs to whatever is open INSIDE the canvas first. SidePanel listens on
          window, so an un-stopped Escape closes the whole drawer and asks whether to
          discard the draft — losing a lesson to dismissing a link box. */}
      <div
        className="lesson-doc-shell"
        onKeyDown={(e) => { if (e.key === 'Escape' && linkBar) closeLink(e); }}
      >
        <div className="lesson-doc-toolbar" role="toolbar" aria-label="Formatting">
          <ToolButton label="Bold" title="Bold (Ctrl+B)" disabled={disabled}
            active={editor.isActive('bold')} onClick={act((c) => c.toggleBold())}>
            <BoldIcon size={14} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Bulleted list" disabled={disabled}
            active={editor.isActive('bulletList')} onClick={act((c) => c.toggleBulletList())}>
            <List size={14} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Numbered list" disabled={disabled}
            active={editor.isActive('orderedList')} onClick={act((c) => c.toggleOrderedList())}>
            <ListOrdered size={14} aria-hidden="true" />
          </ToolButton>
          <span className="lesson-doc-sep" aria-hidden="true" />
          <ToolButton label="Add or edit a link" title="Link (Ctrl+K)" disabled={disabled}
            expanded={!!linkBar} onClick={openLink}>
            <Link2 size={14} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Add an image" disabled={disabled}
            onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={14} aria-hidden="true" />
          </ToolButton>
          <span className="lesson-doc-sep" aria-hidden="true" />
          <ToolButton label="Undo" disabled={disabled} softDisabled={!editor.can().undo()} onClick={act((c) => c.undo())}>
            <Undo2 size={14} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Redo" disabled={disabled} softDisabled={!editor.can().redo()} onClick={act((c) => c.redo())}>
            <Redo2 size={14} aria-hidden="true" />
          </ToolButton>
          <input
            ref={fileInputRef} type="file" accept={LESSON_IMAGE_ACCEPT} multiple className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>

        <div className="lesson-doc-canvas">
          <EditorContent editor={editor} />
        </div>

        {linkBar && (
          <div className="lesson-doc-linkbar" role="group" aria-label="Link">
            <label className="lesson-doc-field is-grow">
              <span className="lesson-doc-field-label">Link address</span>
              <input
                ref={linkUrlRef} value={linkBar.href} inputMode="url"
                placeholder="https://docs.google.com/forms/…"
                onChange={(e) => setLinkBar((b) => ({ ...b, href: e.target.value, error: '' }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); confirmLink(); }
                  if (e.key === 'Escape') closeLink(e);
                }}
                className="lesson-doc-input"
              />
            </label>
            <label className="lesson-doc-field is-grow">
              <span className="lesson-doc-field-label">Text to show</span>
              <input
                value={linkBar.text}
                onChange={(e) => setLinkBar((b) => ({ ...b, text: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); confirmLink(); }
                  if (e.key === 'Escape') closeLink(e);
                }}
                className="lesson-doc-input"
              />
            </label>
            <div className="lesson-doc-linkbar-actions">
              <button type="button" className="lesson-doc-chip is-primary" onClick={confirmLink}>
                {linkBar.editing ? 'Update link' : 'Add link'}
              </button>
              {linkBar.editing && (
                <button type="button" className="lesson-doc-chip" onClick={removeLink}
                  title="Keep the words, remove the address">Unlink</button>
              )}
              <button type="button" className="lesson-doc-chip" onClick={closeLink} aria-label="Cancel">
                <X size={12} aria-hidden="true" />
              </button>
            </div>
            {linkBar.error && (
              <div role="alert" className="lesson-doc-error">
                <AlertTriangle size={12} aria-hidden="true" />{linkBar.error}
              </div>
            )}
          </div>
        )}
      </div>
    </AssetContext.Provider>
  );
});

/** The span of the link the caret sits in, for reading its current words back. */
function linkRange(editor) {
  const { $from } = editor.state.selection;
  const start = $from.pos - $from.textOffset;
  const mark = editor.state.doc.nodeAt(start);
  return [start, start + (mark ? mark.nodeSize : 0)];
}

export default LessonDocumentEditor;
