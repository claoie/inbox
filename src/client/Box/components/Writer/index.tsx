import {
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  MouseEventHandler
} from "react";

import { useMutation, useQueryClient } from "react-query";

import {
  ApiResponse,
  BodyGetResponse,
  SendMailPostBody,
  SendMailPostResponse
} from "server";
import { ReplyData } from "common";

import {
  Context,
  Category,
  useLocalStorage,
  defaultDomainOf,
  domainOf,
  processHtmlToSendMail,
  call,
  useIsOnline,
  useFeedback
} from "client";
import {
  RichTextEditor,
  useRichTextEditor,
  formatActive,
  toggleList,
  toggleMark,
  toggleWrap,
  type Command
} from "client/lib/editor";
import { displayNameFor } from "../Accounts/accountList";

import { SendIcon, AttachIcon } from "./components";
import { CloseIcon } from "../Mails/components";
import FileIcon from "../FileIcon";

import {
  OriginalMessage,
  OriginalMessageMeta,
  EMPTY_ORIGINAL_META,
  wrapQuoteHtml,
  replyDataToOriginalMessage,
  getReplyContainerHtml,
  signatureHtml
} from "./lib";
import { hasDraftFields } from "./draft";
import { invalidAddresses } from "./validate";

import "./index.scss";

const Writer = () => {
  const {
    domainName,
    domains = [],
    userInfo,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData,
    selectedAccount,
    selectedCategory,
    setHasDraft,
    signature = "",
    includeOriginal = true,
    defaultFrom = ""
  } = useContext(Context);

  // The mailbox a new message sends from: the selected one, or the default
  // From when none is selected. While searching, `selectedAccount` carries
  // the search term, not an account address.
  const selectedMailbox =
    selectedAccount && selectedCategory !== Category.Search
      ? selectedAccount
      : "";
  const prefillAccount = selectedMailbox || defaultFrom;

  const { isOnline } = useIsOnline();
  const { showToast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  // Problems found on Send, shown in the form next to the fields instead of
  // in a browser alert.
  const [errors, setErrors] = useState<string[]>([]);

  const [isCcOpen, setIsCcOpen] = useLocalStorage("isCcOpen", false);
  const [isBccOpen, setIsBccOpen] = useLocalStorage("isBccOpen", false);

  const [name, setName] = useLocalStorage("name", "");
  const [to, setTo] = useLocalStorage("to", "");
  const [cc, setCc] = useLocalStorage("cc", "");
  const [bcc, setBcc] = useLocalStorage("bcc", "");
  const [subject, setSubject] = useLocalStorage("subject", "");
  const [sender, setSender] = useLocalStorage("sender", "");
  // The domain the mail goes out from: one the user owns. Pre-filled with the
  // domain of the mailbox (or reply address) the local part came from.
  const [senderDomain, setSenderDomain] = useLocalStorage("senderDomain", "");
  const fallbackDomain = defaultDomainOf(domains, userInfo?.username, domainName);
  const fromDomain = domains.includes(senderDomain) ? senderDomain : fallbackDomain;
  // The mailbox the From pre-fill last wrote, so the draft dot can tell
  // pre-filled values from typed ones even after the selection moves on
  // (entering search, picking another account) — judging against the
  // current selection would light the dot for an untouched compose.
  const [prefilledFrom, setPrefilledFrom] = useLocalStorage(
    "prefilledFrom",
    ""
  );
  const [initialContent, setInitialContent] = useLocalStorage(
    "initialContent",
    ""
  );
  const [originalMessageMeta, setOriginalMessageMeta] =
    useLocalStorage<OriginalMessageMeta>(
      "originalMessageMeta",
      EMPTY_ORIGINAL_META
    );
  const [originalMessageHtml, setOriginalMessageHtml] = useState<string>("");
  const originalMessage = useMemo<OriginalMessage>(
    () => ({ ...originalMessageMeta, html: originalMessageHtml }),
    [originalMessageMeta, originalMessageHtml]
  );
  const setOriginalMessage = useCallback(
    (m: OriginalMessage) => {
      const { html, ...meta } = m;
      setOriginalMessageMeta(meta);
      setOriginalMessageHtml(html);
    },
    [setOriginalMessageMeta]
  );

  // Always-current id, read inside the async re-fetch below to drop a stale
  // resolve (the user may switch replies / clear the form mid-fetch).
  const latestMetaId = useRef(originalMessageMeta.id);
  latestMetaId.current = originalMessageMeta.id;

  const [attachments, setAttachments] = useState<Record<string, File>>({});
  const [editorKey, setEditorKey] = useState(1);

  useEffect(() => {
    localStorage.removeItem("originalMessage");
  }, []);

  // Rehydrate the quoted HTML when a reply was in progress.
  // `originalMessageMeta.id` survives close/reopen via localStorage; the HTML is
  // pulled from the mail body endpoint so it never has to sit in storage. Re-runs
  // when the id changes or the user reconnects, so an offline reopen fills the
  // quote once back online — otherwise a Send before then ships the attribution
  // line over an empty blockquote (Send only gates on `isOnline`, not the fetch).
  // Silent no-op if the mail is gone server-side; the compose form still opens
  // with the draft fields, only the quoted block is missing.
  useEffect(() => {
    const id = originalMessageMeta.id;
    if (!id || originalMessageHtml || !isOnline) return;
    call
      .get<BodyGetResponse>(`/api/mails/body/${id}`)
      .then((r) => {
        if (latestMetaId.current !== id) return;
        if (r.status === "success" && r.body?.html) {
          setOriginalMessageHtml(wrapQuoteHtml(r.body.html));
        }
      })
      .catch(console.error);
  }, [originalMessageMeta.id, originalMessageHtml, isOnline]);

  const editor = useRichTextEditor({
    content: initialContent,
    placeholder: "Write your message…"
  });

  // Toolbar pressed state, refreshed on every document and selection change.
  const [formatState, setFormatState] = useState(() =>
    formatActive(editor.state)
  );
  const refreshFormatState = useCallback(() => {
    setFormatState((prev) => {
      const next = formatActive(editor.state);
      return prev.bold === next.bold &&
        prev.italic === next.italic &&
        prev.bulletList === next.bulletList &&
        prev.blockquote === next.blockquote
        ? prev
        : next;
    });
  }, [editor]);

  useEffect(
    () =>
      editor.onUpdate(() => {
        setInitialContent(editor.getHTML());
        refreshFormatState();
      }),
    [editor, setInitialContent, refreshFormatState]
  );

  // The quoted original renders in its own editable region below the editor
  // (the editor's schema drops images, links and tables, so the raw quote
  // must never round-trip through it — see the note on the quote block).
  // Its DOM is uncontrolled: React never owns the children, and this effect
  // only writes when the state disagrees with what's rendered, so typing in
  // the quote never resets the caret.
  const quoteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = quoteRef.current;
    if (!el) return;
    if (el.innerHTML !== originalMessageHtml) el.innerHTML = originalMessageHtml;
  });

  // Fresh compose pre-fills From (design doc §7). Only when both fields are
  // empty, so a reopened draft — or a deliberately chosen alias — is never
  // clobbered. The ref starts closed: mounting with the writer already open
  // is an open transition too, and a fresh compose deserves the pre-fill.
  const wasWriterOpen = useRef(false);
  useEffect(() => {
    const wasOpen = wasWriterOpen.current;
    wasWriterOpen.current = isWriterOpen;
    if (!isWriterOpen || wasOpen) return;
    if (name || sender) return;
    // A reply or forward is not a new message: it takes From from the
    // selected mailbox only, and the reply sets the address it answers from.
    const account = replyData.id ? selectedMailbox : prefillAccount;
    if (!account) return;
    setName(displayNameFor(account));
    setSender(account.split("@")[0] || "");
    setSenderDomain(domainOf(account));
    setPrefilledFrom(account);
  }, [
    isWriterOpen,
    name,
    sender,
    replyData.id,
    selectedMailbox,
    prefillAccount,
    setName,
    setSender,
    setSenderDomain,
    setPrefilledFrom
  ]);

  // The rail Compose button's draft dot (design doc §7): a draft is any
  // filled field, editor text, or a reply or forward — but only user input
  // counts. The From pre-fill writes the pre-filled mailbox's name/sender,
  // so those values alone must not light the dot.
  useEffect(() => {
    setHasDraft(
      hasDraftFields({
        name,
        to,
        cc,
        bcc,
        subject,
        sender,
        initialContent,
        isReply: !!(originalMessageMeta.id || originalMessageMeta.messageId),
        prefilledName: prefilledFrom ? displayNameFor(prefilledFrom) : undefined,
        prefilledSender: prefilledFrom
          ? prefilledFrom.split("@")[0] || ""
          : undefined
      })
    );
  }, [
    name,
    to,
    cc,
    bcc,
    subject,
    sender,
    initialContent,
    originalMessageMeta.id,
    originalMessageMeta.messageId,
    prefilledFrom,
    setHasDraft
  ]);

  const setEditorContent = useCallback(
    (content: string) => {
      editor.setContent(content);
      setInitialContent(content);
    },
    [editor, setInitialContent]
  );

  const hasDraftContent = hasDraftFields({
    name,
    to,
    cc,
    bcc,
    subject,
    sender,
    initialContent,
    isReply: !!(originalMessageMeta.id || originalMessageMeta.messageId),
    prefilledName: prefilledFrom ? displayNameFor(prefilledFrom) : undefined,
    prefilledSender: prefilledFrom
      ? prefilledFrom.split("@")[0] || ""
      : undefined
  }) || Object.keys(attachments).length > 0;

  const applyReply = useCallback(
    (reply: ReplyData) => {
      // A name still holding the default-From pre-fill would sign a reply
      // sent from another address with the default mailbox's name. A
      // forward has no reply address; it sends from the selected mailbox.
      const replyFrom = reply.to?.address || selectedMailbox;
      if (defaultFrom && replyFrom.toLowerCase() !== defaultFrom.toLowerCase()) {
        const defaultName = displayNameFor(defaultFrom);
        setName((current) => (current === defaultName ? "" : current));
      }
      setSender(reply.to?.address?.split("@")[0] || "");
      if (reply.to?.address) setSenderDomain(domainOf(reply.to.address));
      setTo(reply.from?.value?.[0]?.address || "");
      setCc(reply.cc?.value?.map((e) => e.address).join(", ") || "");
      setBcc(reply.bcc?.value?.map((e) => e.address).join(", ") || "");
      // A reply that carries Cc/Bcc opens those inputs, so the values are
      // visible and editable instead of parked in a hidden disabled field.
      if (reply.cc?.value?.length) setIsCcOpen(true);
      if (reply.bcc?.value?.length) setIsBccOpen(true);

      const subjectLower = (reply.subject || "").toLowerCase();
      const replyMarkExistsInSubect = subjectLower.indexOf("re:") === 0;
      const forwardMarkExistsInSubect = subjectLower.indexOf("fwd:") === 0;
      const originalSubject = reply.subject || "";
      const subject = reply.to?.address
        ? replyMarkExistsInSubect
          ? originalSubject
          : "Re: " + originalSubject
        : forwardMarkExistsInSubect
        ? originalSubject
        : "Fwd: " + originalSubject;
      setSubject(subject);

      const editorContent = reply.to?.address
        ? reply.insight?.suggested_reply || ""
        : "";

      setEditorContent(editorContent);
      setAttachments({});
      const original = replyDataToOriginalMessage(reply);
      // Without the quote a reply still threads: the meta keeps the
      // original's Message-ID for In-Reply-To, and the empty id means no
      // quote is shown or re-fetched. Forwards always carry the original.
      const leaveQuoteOut = !!reply.to?.address && !includeOriginal;
      setOriginalMessage(
        leaveQuoteOut ? { ...original, id: "", prefix: "", html: "" } : original
      );
    },
    [
      setSender,
      setSenderDomain,
      setTo,
      setCc,
      setBcc,
      setSubject,
      setAttachments,
      setOriginalMessage,
      setEditorContent,
      setIsCcOpen,
      setIsBccOpen,
      includeOriginal,
      defaultFrom,
      selectedMailbox,
      setName
    ]
  );

  // Reply and Forward fill every field of the form; a draft already in it is
  // replaced only once the user agrees, otherwise it stays as it was.
  const handledReply = useRef<ReplyData | null>(null);
  useEffect(() => {
    if (!replyData.id || !replyData.messageId || !isWriterOpen) return;
    if (handledReply.current === replyData) return;
    handledReply.current = replyData;
    const reply = replyData;
    setReplyData({});
    if (!hasDraftContent) {
      applyReply(reply);
      return;
    }
    confirm({
      title: "Replace your draft?",
      message:
        "The message you are writing, its recipients and attachments will be lost.",
      confirmLabel: "Replace",
      cancelLabel: "Keep draft",
      danger: true
    }).then((ok) => {
      if (ok) applyReply(reply);
    });
  }, [
    replyData,
    setReplyData,
    isWriterOpen,
    hasDraftContent,
    applyReply,
    confirm
  ]);

  const sendMail = (data: FormData) => {
    return call.postFormData<SendMailPostResponse>("/api/mails/send", data);
  };

  const onSuccessSendMail = (data: ApiResponse<SendMailPostResponse>) => {
    if (data.status !== "success") {
      // Keep the draft and the writer open so the user can fix and resend.
      const message = data.message || "Failed to send. Please try again.";
      setErrors([message]);
      showToast({ message: "Your mail wasn't sent.", tone: "error" });
      return;
    }
    showToast({ message: "Mail sent." });
    // The sent reply joins its conversation and the Sent list.
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        typeof queryKey === "string" &&
        (queryKey.startsWith("/api/mails/thread/") ||
          queryKey.startsWith("/api/mails/headers/"))
    });
    setIsWriterOpen(false);
    clearDraft();
  };

  const mutation = useMutation(sendMail, { onSuccess: onSuccessSendMail });

  const onChangeName = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setName(name);
  };

  const clearDraft = () => {
    setErrors([]);
    setPrefilledFrom("");
    setName("");
    setSender("");
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setEditorContent("");
    setAttachments({});
    setEditorKey(editorKey + 1);
    setOriginalMessage({
      id: "",
      messageId: "",
      html: "",
      subject: "",
      prefix: ""
    });
  };

  // Discard throws the draft away and closes the writer; it asks first when
  // there is anything to lose.
  const onClickDiscard = async () => {
    if (hasDraftContent) {
      const ok = await confirm({
        title: "Discard this draft?",
        message: "The message, its recipients and attachments will be lost.",
        confirmLabel: "Discard",
        danger: true
      });
      if (!ok) return;
    }
    clearDraft();
    setIsWriterOpen(false);
  };

  // Close keeps the draft (it is saved as you type) — the same as tapping
  // Compose again.
  const onClickClose = useCallback(() => {
    setIsWriterOpen(false);
  }, [setIsWriterOpen]);

  // Escape closes the writer, keeping the draft. A dialog open on top owns
  // Escape instead.
  useEffect(() => {
    if (!isWriterOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      onClickClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isWriterOpen, onClickClose]);

  const onClickCc = () => {
    setIsCcOpen(!isCcOpen);
  };

  const onClickBcc = () => {
    setIsBccOpen(!isBccOpen);
  };

  // Formatting toolbar: the editor already has these commands behind
  // keyboard shortcuts; the buttons expose them visibly. `mousedown` must
  // not steal the editor's selection, so it is prevented and focus is
  // returned to the editor after the command runs. (Link has no button:
  // the editor schema carries no link mark, so there is no command to run.)
  const runFormat = (command: Command) => {
    editor.run(command);
    editor.focus();
    refreshFormatState();
  };

  const onClickRemoveQuote = () => {
    setOriginalMessage({
      id: "",
      messageId: "",
      html: "",
      subject: "",
      prefix: ""
    });
  };

  const onInputQuote = () => {
    const el = quoteRef.current;
    if (el) setOriginalMessageHtml(el.innerHTML);
  };

  const onClickAttach = () => {
    const fileInput = document.createElement("input");
    fileInput.setAttribute("type", "file");
    fileInput.multiple = true;
    fileInput.click();
    fileInput.addEventListener("change", () => {
      const timeStamp = Date.now();
      const clonedAttachments: Record<string, File> = { ...attachments };
      const files = Array.from(fileInput.files || []);
      files.forEach((file, i) => {
        clonedAttachments[`${timeStamp}-${i}`] = file;
      });
      setAttachments(clonedAttachments);
    });
  };

  const onClickSend = async () => {
    const problems: string[] = [];
    if (!sender.trim()) problems.push("Enter the account to send from.");
    if (!to.trim()) problems.push("Enter at least one recipient.");
    const bad = [
      ...invalidAddresses(to),
      ...(isCcOpen ? invalidAddresses(cc) : []),
      ...(isBccOpen ? invalidAddresses(bcc) : [])
    ];
    if (bad.length) {
      problems.push(
        `${bad.length === 1 ? "This address isn't" : "These addresses aren't"} valid: ${bad.join(", ")}`
      );
    }
    setErrors(problems);
    if (problems.length) return;

    const ok = await confirm({
      title: "Send this mail?",
      message: `To: ${to}` + (subject ? `\nSubject: ${subject}` : ""),
      confirmLabel: "Send"
    });
    if (!ok) return;

    const formData = new FormData();

    const html =
      processHtmlToSendMail(editor.getHTML()) +
      signatureHtml(signature) +
      "\n\n\n" +
      getReplyContainerHtml(originalMessage);

    const mailData: SendMailPostBody = {
      senderFullName: name,
      sender,
      senderDomain: fromDomain,
      to,
      // A closed Cc/Bcc field is not part of the message the user sees.
      cc: isCcOpen ? cc : "",
      bcc: isBccOpen ? bcc : "",
      subject,
      html,
      inReplyTo: originalMessage.messageId
    };

    for (const key in mailData) {
      const value = mailData[key as keyof SendMailPostBody];
      if (!value) continue;
      formData.append(key, value);
    }

    for (const key in attachments) {
      formData.append("attachments", attachments[key]);
    }

    mutation.mutate(formData);
  };

  const attachmentComponents = Object.keys(attachments).map((key, i) => {
    const file = attachments[key];

    const onClickRemove = () => {
      const clonedAttachments = { ...attachments };
      delete clonedAttachments[key];
      setAttachments(clonedAttachments);
    };

    return (
      <button
        key={i}
        type="button"
        className="attachment cursor"
        title={`Remove ${file.name}`}
        aria-label={`Remove attachment ${file.name}`}
        onClick={onClickRemove}
      >
        <FileIcon />
        <span>{file.name}</span>
        <span className="attachment-remove" aria-hidden="true">
          ×
        </span>
      </button>
    );
  });

  const onClickPadding: MouseEventHandler<HTMLDivElement> = (e) => {
    const target = e.target as HTMLElement;
    const targetClassList = Array.from(target.classList);
    const targetIsPadding = !!targetClassList.find(
      (f) => f === "editor_container_bottom_padding"
    );
    if (targetIsPadding) editor.focus();
  };

  return (
    <blockquote className="writer" aria-label="Compose">
      <div className="writer-top">
        <h2 className="writer-title">
          {originalMessageMeta.id || originalMessageMeta.messageId
            ? subject.toLowerCase().startsWith("fwd:")
              ? "Forward"
              : "Reply"
            : "New message"}
        </h2>
        <button
          type="button"
          className="writer-close"
          aria-label="Close compose (draft is kept)"
          title="Close — your draft is kept"
          onClick={onClickClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="writer-field">
        <span className="fieldName" id="writer-from-label">
          From
        </span>
        <div className="from-row" role="group" aria-labelledby="writer-from-label">
          <input
            id="writer-name"
            className="writer-short"
            placeholder="Your name"
            aria-label="Sender name"
            autoComplete="off"
            value={name}
            onChange={onChangeName}
          />
          <div className="from_address">
            <input
              id="writer-sender"
              className="writer-short"
              placeholder="account"
              aria-label="Sender account"
              autoComplete="off"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
            {domains.length > 1 ? (
              <select
                className="writer-domain"
                aria-label="Sender domain"
                value={fromDomain}
                onChange={(e) => setSenderDomain(e.target.value)}
              >
                {domains.map((domain) => (
                  <option key={domain} value={domain}>
                    @{domain}
                  </option>
                ))}
              </select>
            ) : (
              <span className="helper-text">@{fromDomain}</span>
            )}
          </div>
        </div>
      </div>
      <div className="writer-field">
        <div className="fieldName">
          <label htmlFor="writer-to">To</label>
          <span className="cc-bcc-toggles">
            <button
              type="button"
              className={"small-button" + (isCcOpen ? " active" : "")}
              aria-pressed={isCcOpen}
              aria-label="Show Cc"
              onClick={onClickCc}
            >
              Cc
            </button>
            <button
              type="button"
              className={"small-button" + (isBccOpen ? " active" : "")}
              aria-pressed={isBccOpen}
              aria-label="Show Bcc"
              onClick={onClickBcc}
            >
              Bcc
            </button>
          </span>
        </div>
        <input
          id="writer-to"
          className="writer-long"
          placeholder="Recipients, separated by commas"
          type="text"
          inputMode="email"
          autoComplete="off"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {isCcOpen ? (
        <div className="writer-field">
          <label className="fieldName" htmlFor="writer-cc">
            Cc
          </label>
          <input
            id="writer-cc"
            className="writer-long"
            placeholder="Cc recipients, separated by commas"
            inputMode="email"
            autoComplete="off"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
        </div>
      ) : null}
      {isBccOpen ? (
        <div className="writer-field">
          <label className="fieldName" htmlFor="writer-bcc">
            Bcc
          </label>
          <input
            id="writer-bcc"
            className="writer-long"
            placeholder="Bcc recipients, separated by commas"
            inputMode="email"
            autoComplete="off"
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
          />
        </div>
      ) : null}
      <div className="writer-field">
        <label className="fieldName" htmlFor="writer-subject">
          Subject
        </label>
        <input
          id="writer-subject"
          className="writer-long"
          placeholder="Subject"
          autoComplete="off"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="writer-body">
        <div className="writer-toolbar">
          <div
            className="format-toolbar"
            role="toolbar"
            aria-label="Formatting"
          >
            <button
              type="button"
              className={"small-button" + (formatState.bold ? " active" : "")}
              aria-pressed={formatState.bold}
              aria-label="Bold"
              title="Bold"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runFormat(toggleMark("bold"))}
            >
              <b>B</b>
            </button>
            <button
              type="button"
              className={"small-button" + (formatState.italic ? " active" : "")}
              aria-pressed={formatState.italic}
              aria-label="Italic"
              title="Italic"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runFormat(toggleMark("italic"))}
            >
              <i>I</i>
            </button>
            <button
              type="button"
              className={
                "small-button" + (formatState.bulletList ? " active" : "")
              }
              aria-pressed={formatState.bulletList}
              aria-label="Bulleted list"
              title="Bulleted list"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runFormat(toggleList("bulletList"))}
            >
              List
            </button>
            <button
              type="button"
              className={
                "small-button" + (formatState.blockquote ? " active" : "")
              }
              aria-pressed={formatState.blockquote}
              aria-label="Quote"
              title="Quote"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runFormat(toggleWrap("blockquote"))}
            >
              Quote
            </button>
          </div>
          <button
            type="button"
            className="small-button attach-button"
            aria-label="Attach files"
            title="Attach files"
            onClick={onClickAttach}
          >
            <AttachIcon />
            <span>Attach</span>
          </button>
        </div>
        <div className="writer-content-wrap">
          {attachmentComponents.length ? (
            <div className="attachmentBox">{attachmentComponents}</div>
          ) : (
            <></>
          )}
          <div
            className={
              "writer-content margin_box" + (isWriterOpen ? " open" : "")
            }
          >
            <div
              className="editor_container_bottom_padding"
              onClick={onClickPadding}
              onSelect={refreshFormatState}
              onKeyUp={refreshFormatState}
            >
              <RichTextEditor editor={editor} />
              {signature.trim() ? (
                <div className="signature-preview" aria-label="Signature">
                  {signature}
                </div>
              ) : null}
              {originalMessage.id ? (
                <div className="original_message">
                  <div className="quote-header">
                    <div className="suffix">{originalMessage.prefix}</div>
                    <button
                      type="button"
                      className="small-button quote-remove"
                      aria-label="Remove quote"
                      title="Remove quote"
                      onClick={onClickRemoveQuote}
                    >
                      Remove quote
                    </button>
                  </div>
                  {originalMessage.subject ? (
                    <blockquote className="quote-subject">
                      {originalMessage.subject}
                    </blockquote>
                  ) : (
                    <></>
                  )}
                  <div
                    ref={quoteRef}
                    className="original_message_body"
                    contentEditable
                    suppressContentEditableWarning
                    onInput={onInputQuote}
                    aria-label="Quoted message"
                  />
                </div>
              ) : (
                <></>
              )}
            </div>
          </div>
        </div>
      </div>
      {errors.length ? (
        <ul className="writer-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <div className="writer-buttons">
        <button type="button" className="discard" onClick={onClickDiscard}>
          Discard
        </button>
        <button
          type="button"
          className="send"
          onClick={onClickSend}
          disabled={!isOnline || mutation.isLoading}
          title={
            isOnline ? undefined : "You're offline — reconnect to send mail"
          }
        >
          <SendIcon />
          <span>{mutation.isLoading ? "Sending…" : "Send"}</span>
        </button>
      </div>
    </blockquote>
  );
};

export default Writer;
