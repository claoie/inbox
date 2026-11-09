import {
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  MouseEventHandler
} from "react";

import { useMutation } from "react-query";

import {
  ApiResponse,
  BodyGetResponse,
  SendMailPostBody,
  SendMailPostResponse
} from "server";

import {
  Context,
  Category,
  useLocalStorage,
  processHtmlToSendMail,
  call,
  useIsOnline
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

import { SendIcon, AttachIcon, EraserIcon } from "./components";
import FileIcon from "../FileIcon";

import {
  OriginalMessage,
  OriginalMessageMeta,
  EMPTY_ORIGINAL_META,
  wrapQuoteHtml,
  replyDataToOriginalMessage,
  getReplyContainerHtml
} from "./lib";
import { hasDraftFields } from "./draft";

import "./index.scss";

const Writer = () => {
  const {
    domainName,
    isWriterOpen,
    setIsWriterOpen,
    replyData,
    setReplyData,
    selectedAccount,
    selectedCategory,
    setHasDraft
  } = useContext(Context);

  const { isOnline } = useIsOnline();

  const [isCcOpen, setIsCcOpen] = useLocalStorage("isCcOpen", false);
  const [isBccOpen, setIsBccOpen] = useLocalStorage("isBccOpen", false);

  const [name, setName] = useLocalStorage("name", "");
  const [to, setTo] = useLocalStorage("to", "");
  const [cc, setCc] = useLocalStorage("cc", "");
  const [bcc, setBcc] = useLocalStorage("bcc", "");
  const [subject, setSubject] = useLocalStorage("subject", "");
  const [sender, setSender] = useLocalStorage("sender", "");
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

  // Fresh compose pre-fills From from the selected mailbox (design doc §7).
  // Only when both fields are empty, so a reopened draft — or a deliberately
  // chosen alias — is never clobbered. Not while searching: there
  // `selectedAccount` carries the search term, not an account address.
  // The ref starts closed: mounting with the writer already open is an
  // open transition too, and a fresh compose deserves the pre-fill.
  const wasWriterOpen = useRef(false);
  useEffect(() => {
    const wasOpen = wasWriterOpen.current;
    wasWriterOpen.current = isWriterOpen;
    if (!isWriterOpen || wasOpen) return;
    if (name || sender) return;
    if (!selectedAccount || selectedCategory === Category.Search) return;
    setName(displayNameFor(selectedAccount));
    setSender(selectedAccount.split("@")[0] || "");
  }, [
    isWriterOpen,
    name,
    sender,
    selectedAccount,
    selectedCategory,
    setName,
    setSender
  ]);

  // The rail Compose button's draft dot (design doc §7): a draft is any
  // filled field, editor text, or an attached quote — but only user input
  // counts. The From pre-fill writes the selected mailbox's name/sender,
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
        hasQuote: !!originalMessageMeta.id,
        prefilledName: displayNameFor(selectedAccount),
        prefilledSender: selectedAccount.split("@")[0] || ""
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
    selectedAccount,
    setHasDraft
  ]);

  const setEditorContent = useCallback(
    (content: string) => {
      editor.setContent(content);
      setInitialContent(content);
    },
    [editor, setInitialContent]
  );

  useEffect(() => {
    if (replyData.id && replyData.messageId && setReplyData && isWriterOpen) {
      setSender(replyData.to?.address?.split("@")[0] || "");
      setTo(replyData.from?.value?.[0]?.address || "");
      setCc(replyData.cc?.value?.map((e) => e.address).join(", ") || "");
      setBcc(replyData.bcc?.value?.map((e) => e.address).join(", ") || "");
      // A reply that carries Cc/Bcc opens those inputs, so the values are
      // visible and editable instead of parked in a hidden disabled field.
      if (replyData.cc?.value?.length) setIsCcOpen(true);
      if (replyData.bcc?.value?.length) setIsBccOpen(true);

      const subjectLower = (replyData.subject || "").toLowerCase();
      const replyMarkExistsInSubect = subjectLower.indexOf("re:") === 0;
      const forwardMarkExistsInSubect = subjectLower.indexOf("fwd:") === 0;
      const originalSubject = replyData.subject || "";
      const subject = replyData.to?.address
        ? replyMarkExistsInSubect
          ? originalSubject
          : "Re: " + originalSubject
        : forwardMarkExistsInSubect
        ? originalSubject
        : "Fwd: " + originalSubject;
      setSubject(subject);

      const editorContent = replyData.to?.address
        ? replyData.insight?.suggested_reply || ""
        : "";

      setEditorContent(editorContent);
      setAttachments({});
      setOriginalMessage(replyDataToOriginalMessage(replyData));

      setReplyData({});
    }
  }, [
    setSender,
    setTo,
    setCc,
    setBcc,
    setSubject,
    setAttachments,
    replyData,
    setReplyData,
    isWriterOpen,
    setOriginalMessage,
    setEditorContent,
    setIsCcOpen,
    setIsBccOpen
  ]);

  const sendMail = (data: FormData) => {
    return call.postFormData<SendMailPostResponse>("/api/mails/send", data);
  };

  const onSuccessSendMail = (data: ApiResponse<SendMailPostResponse>) => {
    if (data.status !== "success") {
      return alert(data.message || "Failed to send. Please try again.");
    }
    alert("Your mail is sent successfully");
    setIsWriterOpen(false);
    onClickEraserIcon();
  };

  const mutation = useMutation(sendMail, { onSuccess: onSuccessSendMail });

  const onChangeName = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setName(name);
  };

  const onClickEraserIcon = () => {
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

  const onClickSend = () => {
    if (!sender.trim()) return alert("Please enter a sender account name.");
    if (!to.trim()) return alert("Please enter a recipient email address.");
    if (!window.confirm("Do you want to send it?")) return;

    const formData = new FormData();

    const html =
      processHtmlToSendMail(editor.getHTML()) +
      "\n\n\n" +
      getReplyContainerHtml(originalMessage);

    const mailData: SendMailPostBody = {
      senderFullName: name,
      sender,
      to,
      cc,
      bcc,
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
      <div
        key={i}
        className="attachment cursor"
        title="Click to remove"
        onClick={onClickRemove}
      >
        <FileIcon />
        <span>{file.name}</span>
      </div>
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
    <blockquote className="writer">
      <div>
        <div className="fieldName">
          <span>From:</span>
          <span>
            <EraserIcon className="cursor" onClick={onClickEraserIcon} />
          </span>
        </div>
        <div className="margin_box inputBox-flex">
          <input
            className="writer-short"
            placeholder="name"
            autoComplete="off"
            value={name}
            onChange={onChangeName}
          />
          <div className="from_address">
            <span className="helper-text"> &lt; </span>
            <input
              className="writer-short"
              placeholder="account"
              autoComplete="off"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
            <span className="helper-text">@{domainName} &gt;</span>
          </div>
        </div>
      </div>
      <div>
        <div className="fieldName">
          <span>To: </span>
          <span className="cc-bcc-toggles">
            <button
              type="button"
              className={"small-button" + (isCcOpen ? " active" : "")}
              aria-pressed={isCcOpen}
              onClick={onClickCc}
            >
              Cc
            </button>
            <button
              type="button"
              className={"small-button" + (isBccOpen ? " active" : "")}
              aria-pressed={isBccOpen}
              onClick={onClickBcc}
            >
              Bcc
            </button>
          </span>
        </div>
        <div className="inputBox-flex margin_box">
          <input
            className="writer-long"
            placeholder="to-1@email.com, to-2@email.com"
            autoComplete="off"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <input
            className={isCcOpen ? "writer-long" : "writer-long hide"}
            placeholder="cc-1@email.com, cc-2@email.com"
            autoComplete="off"
            disabled={isCcOpen ? false : true}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
          <input
            className={isBccOpen ? "writer-long" : "writer-long hide"}
            placeholder="bcc-1@email.com, bcc-2@email.com"
            autoComplete="off"
            disabled={isBccOpen ? false : true}
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
          />
        </div>
      </div>
      <div>
        <div className="fieldName">Subject: </div>
        <div className="inputBox-flex margin_box">
          <input
            className="writer-long"
            placeholder="This is the mail subject"
            autoComplete="off"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      </div>
      <div className="writer-body">
        <div className="fieldName">
          <span>Content: </span>
          <span>
            <AttachIcon className="cursor" onClick={onClickAttach} />
          </span>
        </div>
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
            className={"small-button" + (formatState.bulletList ? " active" : "")}
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
            className={"small-button" + (formatState.blockquote ? " active" : "")}
            aria-pressed={formatState.blockquote}
            aria-label="Quote"
            title="Quote"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runFormat(toggleWrap("blockquote"))}
          >
            Quote
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
                      ×
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
      <div className="writer-buttons">
        <button type="button" className="discard" onClick={onClickEraserIcon}>
          Discard
        </button>
        <button
          onClick={onClickSend}
          disabled={!isOnline}
          title={
            isOnline ? undefined : "You're offline — reconnect to send mail"
          }
        >
          <SendIcon />
          <span>Send</span>
        </button>
      </div>
    </blockquote>
  );
};

export default Writer;
