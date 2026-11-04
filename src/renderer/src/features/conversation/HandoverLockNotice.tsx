// Fork: travel handover (docs/fork/travel-handover.md). Takes the composer's place while a person
// continues the chat on a server, so the chat never splits in two.

import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal } from "solid-js";
import { reportErrorBanner } from "../../error-reports";

export function HandoverLockNotice(props: { agentId: string; serverName: string }) {
  const { t } = useText();
  const [bringing, setBringing] = createSignal(false);
  const bringBack = async () => {
    setBringing(true);
    try {
      await window.openbot.forkHandover.bringBack(props.agentId);
    } catch (error) {
      reportErrorBanner(error);
    } finally {
      setBringing(false);
    }
  };
  return (
    <div class="handover-lock-notice">
      <p class="channel-preview-notice">{t("conversation.handover.notice", { server: props.serverName })}</p>
      <Button
        variant="outline"
        size="sm"
        loading={bringing()}
        loadingLabel={t("conversation.handover.bringingBack")}
        onClick={() => void bringBack()}
      >
        {t("conversation.handover.bringBack")}
      </Button>
    </div>
  );
}
