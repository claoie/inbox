import { useContext } from "react";
import { Context, Density } from "client";
import { Allowlist } from "./components";
import "./index.scss";

const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" }
];

const Settings = () => {
  const { density, setDensity } = useContext(Context);

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
        <h3>Spam allowlist</h3>
        <Allowlist />
      </div>
    </section>
  );
};

export default Settings;
