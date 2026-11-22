import {
  useState,
  useContext,
  useEffect,
  useRef,
  ReactEventHandler,
  useCallback
} from "react";
import { useQuery } from "react-query";
import { AttachmentType, MailBodyData } from "common";
import { BodyGetResponse } from "server";
import {
  Context,
  ContextType,
  call,
  countRemoteImages,
  processHtmlForViewer,
  useResolvedTheme
} from "client";
import { formatFileSize } from "client/lib/formatters";
import FileIcon from "client/Box/components/FileIcon";

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

interface Props {
  mailId: string;
}

const replaceBlockquoteWithDetails = (text: string, blockquote: Element) => {
  const details = window.document.createElement("details");
  details.innerHTML =
    "<summary>" +
    text.replace("<", "&lt;").replace(">", "&gt;") +
    "</summary>" +
    "<hr/>" +
    blockquote.innerHTML;
  details.style.marginTop = "16px";
  blockquote.parentNode?.replaceChild(details, blockquote);
  return details;
};

const MailBody = ({ mailId }: Props) => {
  const { theme = "system" } = useContext(Context) as ContextType;
  const resolvedTheme = useResolvedTheme(theme);

  const [isLoadingIframe, setIsLoadingIframe] = useState(true);
  // Remote images stay hidden until the reader asks for them: loading one
  // tells the sender the mail was opened, and when and where.
  const [showRemoteImages, setShowRemoteImages] = useState(false);

  const queryUrl = `/api/mails/body/${mailId}`;

  const getMail = async () => {
    const { status, body, message } = await call.get<BodyGetResponse>(queryUrl);
    if (status === "success") return new MailBodyData(body);
    else throw new Error(message);
  };
  const query = useQuery<MailBodyData>(queryUrl, getMail);

  const iframeElement = useRef<HTMLIFrameElement>(null);
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pendingFrames = useRef<number[]>([]);

  // Cancel all pending timers/frames when the component unmounts
  useEffect(() => {
    return () => {
      pendingTimers.current.forEach(clearTimeout);
      pendingTimers.current = [];
      pendingFrames.current.forEach(cancelAnimationFrame);
      pendingFrames.current = [];
    };
  }, []);

  const adjustMailContentSize = useCallback(
    (iframeDom: HTMLIFrameElement | null) => {
      if (!iframeDom || !iframeDom.contentWindow) return;
      const content = iframeDom.contentWindow.document.body;
      if (!content) return;

      // The iframe-body's `position: absolute` (applied below on the
      // first run) makes the body contribute 0 to its iframe's natural
      // layout height. So when we reset `iframeDom.style.height` to
      // "auto" to re-measure, the iframe collapses to 0 height for a
      // tick, the outer page reflows, and the browser ends up
      // re-anchoring scroll to the top of the mail body. The visible
      // bug: any click inside the iframe (which re-fires this through
      // the click listener below) snaps the page back to the top of
      // the body. Snapshot scrollY before the measure-reset and
      // restore it after the resize completes.
      const savedScroll = window.scrollY;

      // Collapse the iframe before measuring. The body is `height: 100%`,
      // so its scrollHeight is never less than the iframe's own height; with
      // `height: auto` that is the 150px default, which left a short mail
      // sitting in a box of empty space.
      iframeDom.style.height = "0px";

      const contentHeight = content.scrollHeight;
      const contentWidth = content.scrollWidth;
      const adjustedContentWidth = iframeDom.offsetWidth - 16;
      const scale = adjustedContentWidth / contentWidth;
      const adjustedContentHeight = scale * contentHeight;
      const adjustedClientHeight = adjustedContentHeight + 32;

      content.style.transform = `scale(${scale})`;
      content.style.position = "absolute";
      content.style.top = (adjustedContentHeight * (1 - scale)) / -2 + "px";
      content.style.left = (adjustedContentWidth * (1 - scale)) / -2 + "px";

      iframeDom.style.height = adjustedClientHeight + "px";
      iframeDom.style.paddingTop = "8px";
      iframeDom.style.paddingBottom = "24px";

      if (window.scrollY !== savedScroll) window.scrollTo({ top: savedScroll });
    },
    []
  );

  // Shown both while the body fetch is in flight and while the
  // iframe is still loading after the fetch resolves.
  const BodyLoadingSkeleton = () => (
    <div
      className="body-skeleton loading_animation"
      role="status"
      aria-label="Loading message"
    >
      <div />
      <div />
      <div />
      <div />
    </div>
  );

  if (query.isLoading) {
    return (
      <div className="text">
        <BodyLoadingSkeleton />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="text">
        <div className="loading_message">Mail Data Request Failed</div>
      </div>
    );
  }

  const data = query.data;

  if (query.isSuccess && data) {
    const attachmentList = Array.isArray(data.attachments)
      ? data.attachments
      : [];
    const attachments: JSX.Element[] = attachmentList.map(
      (attachment: AttachmentType, i: number) => {
        const onClickAttachment = () => {
          call
            .binary(`/api/mails/attachment/${attachment.content.data}`)
            .then((buffer) => {
              const link = document.createElement("a");
              const blob = new Blob([buffer], { type: attachment.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = attachment.filename;
              link.click();
            })
            .catch(console.error);
        };
        return (
          <button
            key={i}
            type="button"
            className="attachment cursor"
            onClick={onClickAttachment}
            title={`Download ${attachment.filename}`}
          >
            <FileIcon />
            <span className="attachment-name">{attachment.filename}</span>
            {attachment.size ? (
              <span className="attachment-size">
                {formatFileSize(attachment.size)}
              </span>
            ) : null}
          </button>
        );
      }
    );

    const onLoadIframe: ReactEventHandler<HTMLIFrameElement> = (e) => {
      setIsLoadingIframe(false);

      const iframeDom = e.target as HTMLIFrameElement;

      if (!iframeDom || !iframeDom.contentWindow) return;
      const content = iframeDom.contentWindow.document.body;
      if (!content) return;

      content.addEventListener("click", () => {
        const id = setTimeout(() => adjustMailContentSize(iframeDom), 50);
        pendingTimers.current.push(id);
      });

      Array.from(content.querySelectorAll("a")).forEach((e) => {
        const target = e.getAttribute("target");
        if (!target || target[0] === "_") e.setAttribute("target", "_blank");
        // `a` also matches SVG <a>, which has no innerText.
        if (e.namespaceURI !== XHTML_NAMESPACE) return;
        const text = e.innerText.replaceAll("\\n", " ");
        e.innerText = text.length > 50 ? text.substring(0, 47) + "..." : text;
      });

      Array.from(content.querySelectorAll("div, p, blockquote"))
        .reverse()
        .forEach((e) => {
          const children = Array.from(e.childNodes);
          const firstTextNodeIndex = children.findIndex(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
          );
          // @ts-ignore
          const lastTextNodeIndex = children.findLastIndex(
            // @ts-ignore
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
          );

          const text = children
            .slice(firstTextNodeIndex, lastTextNodeIndex + 1)
            .map((node) => node.textContent)
            .join(" ")
            .trim();

          const regex = /^On.*wrote:/;
          if (regex.test(text)) {
            if (e.nodeName === "BLOCKQUOTE") {
              replaceBlockquoteWithDetails(text, e);
            } else {
              let sibling = e.nextElementSibling;
              while (sibling) {
                if (sibling.matches("blockquote")) break;
                sibling = sibling.nextElementSibling;
              }
              if (sibling && sibling.nodeName === "BLOCKQUOTE") {
                replaceBlockquoteWithDetails(text, sibling);
                e.parentNode?.removeChild(e);
              } else {
                const blockquote = e.querySelector("blockquote");
                if (blockquote) replaceBlockquoteWithDetails(text, blockquote);
              }
            }
            for (let i = firstTextNodeIndex; i <= lastTextNodeIndex; i++) {
              if (children[i]) e.removeChild(children[i]);
            }
          }
        });

      // Native `toggle` fires after the browser lays out the slotted
      // content, so `scrollHeight` read in the handler reflects the new
      // size — robust under keyboard activation and slow renders, where
      // the body-level click listener's setTimeout(50) heuristic misses.
      // Defer the resize past the current layout pass with a double
      // requestAnimationFrame: mutating the iframe height synchronously
      // inside `toggle` re-enters the browser's ResizeObserver
      // notification cycle within the same frame, which it cannot
      // complete and reports as a global "ResizeObserver loop completed
      // with undelivered notifications" error.
      Array.from(content.querySelectorAll("details")).forEach((det) => {
        det.addEventListener("toggle", () => {
          const outer = requestAnimationFrame(() => {
            const inner = requestAnimationFrame(() =>
              adjustMailContentSize(iframeDom)
            );
            pendingFrames.current.push(inner);
          });
          pendingFrames.current.push(outer);
        });
      });

      adjustMailContentSize(iframeDom);
      const id = setTimeout(() => adjustMailContentSize(iframeDom), 50);
      pendingTimers.current.push(id);
    };

    const remoteImageCount = showRemoteImages ? 0 : countRemoteImages(data.html);

    return (
      <div className="text">
        {isLoadingIframe ? <BodyLoadingSkeleton /> : null}
        {remoteImageCount > 0 ? (
          <div className="remote-images-notice" role="status">
            <span>
              {remoteImageCount === 1
                ? "1 remote image is hidden to protect your privacy."
                : `${remoteImageCount} remote images are hidden to protect your privacy.`}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setIsLoadingIframe(true);
                setShowRemoteImages(true);
              }}
            >
              Show images
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachmentBox">{attachments}</div>
        ) : (
          <></>
        )}
        <iframe
          title={mailId}
          srcDoc={processHtmlForViewer(data.html, {
            blockRemoteImages: !showRemoteImages,
            theme: resolvedTheme
          })}
          onLoad={onLoadIframe}
          ref={iframeElement}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    );
  }

  return <></>;
};

export default MailBody;
