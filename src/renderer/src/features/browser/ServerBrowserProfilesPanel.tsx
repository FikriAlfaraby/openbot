import type { AgentSummary, BrowserChromeLink, BrowserChromeProfile, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { BrowserProfilesPanel } from "@openbot/ui/features/browser/BrowserProfilesPanel";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal } from "solid-js";
import { actionToast } from "../../action-toast";
import type { BrowserProfilesStore } from "./stores/browser-profiles-store";

export interface ServerBrowserProfilesOptions {
  /** The profiles of the server whose settings are open. A new store means another server. */
  store: Omit<BrowserProfilesStore, "assign">;
  /** The agents of the same server, for the names in the delete question. */
  listAgents: () => Promise<readonly Pick<AgentSummary, "id" | "name">[]>;
  /** Fork: the Chrome links of this Mac's profiles. Only for the local server of a Mac. */
  chrome?: Pick<OpenBotDesktopApi["browser"], "chromeProfiles" | "chromeLinks" | "setChromeLink" | "syncChromeProfile">;
}

/**
 * The Browser profiles section of the server settings. It lists the profiles each time it opens,
 * and again when the settings change to another server. The list also counts the agents of the
 * shared profile, and each change lists it again, because a delete moves agents. A change made on
 * another device, such as the phone, shows while the section is open.
 */
export function ServerBrowserProfilesPanel(
  props: ServerBrowserProfilesOptions & { menuMount: HTMLElement | undefined },
) {
  const { t, errorMessage } = useText();
  const [agentNames, setAgentNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [chromeProfiles, setChromeProfiles] = createSignal<readonly BrowserChromeProfile[] | undefined>();
  const [chromeLinks, setChromeLinks] = createSignal<readonly BrowserChromeLink[]>([]);
  // Fork: Chrome profiles come from this Mac. Without them, or without access, the panel shows no Chrome items.
  createEffect(
    () => props.chrome,
    (chrome) => {
      setChromeProfiles(undefined);
      if (!chrome) return;
      chrome.chromeProfiles().then(setChromeProfiles, () => setChromeProfiles(undefined));
      chrome.chromeLinks().then(setChromeLinks, () => setChromeLinks([]));
    },
  );
  const chrome = () => {
    const api = props.chrome;
    const profiles = chromeProfiles();
    if (!api || !profiles || profiles.length === 0) return undefined;
    return {
      profiles,
      linkOf: (profileId: string | null) => chromeLinks().find((link) => link.profileId === profileId)?.chromeProfileId,
      onLink: async (profileId: string | null, chromeProfileId: string | null) => {
        await api.setChromeLink({ profileId, chromeProfileId });
        setChromeLinks(await api.chromeLinks());
      },
      onSync: async (profileId: string | null) => (await api.syncChromeProfile({ profileId })).cookies,
    };
  };
  let request = 0;
  createEffect(
    () => props.store,
    (store) => {
      const current = ++request;
      setAgentNames(new Map());
      store
        .refresh()
        .catch((error: unknown) => actionToast.error(errorMessage(error, t("browser.profiles.loadFailed"))));
      // A name only makes the delete question clearer, so a failed read leaves it out.
      props.listAgents().then(
        (agents) => {
          if (current === request) setAgentNames(new Map(agents.map((agent) => [agent.id, agent.name])));
        },
        () => undefined,
      );
      return store.follow();
    },
  );
  return (
    <BrowserProfilesPanel
      profiles={props.store.state.profiles}
      sharedAgentCount={props.store.state.sharedAgentIds?.length}
      agentName={(agentId) => agentNames().get(agentId)}
      onCreate={async (name) => {
        await props.store.create(name);
      }}
      onRename={props.store.rename}
      onRecolor={props.store.recolor}
      onClear={props.store.clear}
      onDelete={props.store.remove}
      menuMount={props.menuMount}
      chrome={chrome()}
    />
  );
}
