import { useContext, useMemo, useState } from "react";
import { useQuery } from "react-query";
import { AccountsGetResponse } from "server";
import { Context, Density, Notifier } from "client";
import { accountsQueryUrl, fetchAccounts } from "../Accounts";
import { Allowlist } from "./components";
import { fromOptions } from "./fromOptions";
import "./index.scss";

const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" }
];

const Settings = () => {
  const {
    density,
    setDensity,
    domainName,
    signature,
    setSignature,
    includeOriginal,
    setIncludeOriginal,
    defaultFrom,
    setDefaultFrom,
    notificationsEnabled,
    setNotificationsEnabled
  } = useContext(Context);

  const notifier = useMemo(() => new Notifier(), []);
  const [permission, setPermission] = useState(notifier.permission);
  const [isSwitchingNotifications, setIsSwitchingNotifications] =
    useState(false);
  const notificationsBlocked =
    permission === "denied" || permission === "unsupported";

  const onChangeNotifications = async (on: boolean) => {
    setIsSwitchingNotifications(true);
    try {
      if (!on) {
        setNotificationsEnabled(false);
        await notifier.unsubscribe();
        return;
      }
      if (permission === "default") {
        await notifier.requestPermission();
        setPermission(notifier.permission);
        if (notifier.permission !== "granted") return;
      }
      setNotificationsEnabled(true);
      await notifier.subscribe();
    } finally {
      setIsSwitchingNotifications(false);
    }
  };

  const notificationsDescription =
    permission === "unsupported"
      ? "This browser can't show notifications from this site."
      : permission === "denied"
        ? "Notifications for this site are blocked in your browser's settings."
        : "Turning them off also stops the unread count on the app icon " +
          "from updating while the app is closed.";

  // The accounts panel owns this query; read its data without fetching.
  const accountsQuery = useQuery<AccountsGetResponse>(
    accountsQueryUrl,
    fetchAccounts,
    { enabled: false }
  );
  const addresses = fromOptions(accountsQuery.data, domainName, defaultFrom);

  return (
    <section className="settings" aria-label="Settings">
      <h2>Settings</h2>

      <div className="settings-group">
        <h3>Appearance</h3>
        <div className="settings-row">
          <div className="settings-label">
            Density
            <div className="settings-description">
              Comfortable shows a preview of each message; Compact hides it and
              tightens the rows.
            </div>
          </div>
          <div className="segmented" role="group" aria-label="List density">
            {densityOptions.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={"small-button" + (density === value ? " active" : "")}
                aria-pressed={density === value}
                onClick={() => setDensity(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h3>Compose</h3>
        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-default-from">
            Default From account
            <span className="settings-description">
              Fills in From on a new message when no mailbox is selected.
            </span>
          </label>
          <select
            id="settings-default-from"
            value={defaultFrom}
            onChange={(e) => setDefaultFrom(e.target.value)}
          >
            <option value="">None</option>
            {addresses.map((address) => (
              <option key={address} value={address}>
                {address}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row settings-row-stacked">
          <label className="settings-label" htmlFor="settings-signature">
            Signature
            <span className="settings-description">
              Added below your message when you send it.
            </span>
          </label>
          <textarea
            id="settings-signature"
            rows={3}
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
          />
        </div>
        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-include-original">
            Include original when replying
            <span className="settings-description">
              When off, a new reply starts without the quoted message.
              Forwards always include it.
            </span>
          </label>
          <input
            id="settings-include-original"
            type="checkbox"
            checked={includeOriginal}
            onChange={(e) => setIncludeOriginal(e.target.checked)}
          />
        </div>
      </div>

      <div className="settings-group">
        <h3>Notifications</h3>
        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-notifications">
            Desktop notifications for new mail
            <span className="settings-description">
              {notificationsDescription}
            </span>
          </label>
          <input
            id="settings-notifications"
            type="checkbox"
            checked={notificationsEnabled && permission === "granted"}
            disabled={notificationsBlocked || isSwitchingNotifications}
            onChange={(e) => onChangeNotifications(e.target.checked)}
          />
        </div>
      </div>

      <div className="settings-group">
        <h3>Spam allowlist</h3>
        <Allowlist />
      </div>
    </section>
  );
};

export default Settings;
