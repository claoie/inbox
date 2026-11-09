import { PushSubscription } from "web-push";
import { PublicKeyGetResponse, RefreshGetResponse, SubscribePostBody, SubscribePostResponse } from "server";
import { call } from "./call";
import { getLocalStorageItem, setLocalStorageItem } from "./cache";

// Extended Navigator interface for Badging API (not yet in standard TypeScript types)
interface NavigatorWithBadging extends Navigator {
  setAppBadge(contents?: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

export class Notifier {
  constructor() {
    if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
      this.isBadgeAvailable = true;
    }
    if (
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window
    ) {
      this.isNotificationAvailable = true;
    }
  }

  private isBadgeAvailable = false;
  private isNotificationAvailable = false;

  setBadge = (number: number) => {
    if (!this.isBadgeAvailable) return;
    (navigator as NavigatorWithBadging).setAppBadge(number).catch(console.error);
  };

  clearBadge = () => {
    if (!this.isBadgeAvailable) return;
    (navigator as NavigatorWithBadging).clearAppBadge().catch(console.error);
  };

  /** What this browser allows: `unsupported` when it has no push notifications. */
  get permission(): NotificationPermission | "unsupported" {
    return this.isNotificationAvailable ? Notification.permission : "unsupported";
  }

  requestPermission = () => {
    if (!this.isNotificationAvailable) return;
    return Notification.requestPermission();
  };

  notify = (arg: { title: string; body?: string; icon?: string }) => {
    if (!this.isNotificationAvailable) return;
    const { title, body, icon } = arg;
    const options = { body, icon };
    new Notification(title, options);
  };

  subscribe = async () => {
    if (!this.isNotificationAvailable) return;
    if (Notification.permission !== "granted") return;

    await navigator.serviceWorker.register("/service-worker.js");
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();

    const savedSubscriptionId = getLocalStorageItem("push_subscription_id");

    if (existing && savedSubscriptionId) {
      const apiPath = "/api/push/refresh/" + savedSubscriptionId;
      const refreshResult = await call.get<RefreshGetResponse>(apiPath);
      if (refreshResult.status === "success") return;
    }

    existing?.unsubscribe();
    setLocalStorageItem("push_subscription_id", undefined);

    try {
      const applicationServerKey = await call
        .get<PublicKeyGetResponse>("/api/push/public-key")
        .then(({ body }) => body);

      const subscription = await registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey })
        .then((s) => s as unknown as PushSubscription);

      const callPost = call.post<SubscribePostResponse, SubscribePostBody>;
      const apiPath = "/api/push/subscribe";
      const postResult = await callPost(apiPath, { subscription });
      const { body: newSubscriptionId } = postResult;

      setLocalStorageItem("push_subscription_id", newSubscriptionId);

      console.log("Subscribed to push notifications");
    } catch (error) {
      console.error("Error subscribing to push notifications:", error);
    }
  };

  /**
   * Stops push to this browser: the server drops its subscription and the
   * browser forgets its own, so `subscribe` starts from scratch next time.
   */
  unsubscribe = async () => {
    const savedSubscriptionId = getLocalStorageItem("push_subscription_id");
    if (savedSubscriptionId) {
      await call.delete("/api/push/subscribe/" + savedSubscriptionId);
    }
    setLocalStorageItem("push_subscription_id", undefined);
    if (!this.isNotificationAvailable) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      await existing?.unsubscribe();
    } catch (error) {
      console.error("Error unsubscribing from push notifications:", error);
    }
  };
}
