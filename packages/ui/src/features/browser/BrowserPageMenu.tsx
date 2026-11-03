import type { BrowserChromeProfile } from "@openbot/contracts/ipc";
import { buttonVariants, ChevronRight, DropdownMenu, Ellipsis } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { BrowserShortcutHint } from "./BrowserTabIcon";
import { type BrowserFullViewProps, browserTabStoppable } from "./browser-full-view-types";
import { useBrowserPageCover } from "./browser-page-cover";

/** The actions of the view in one menu: a new tab, reopen, Picture in Picture, a sign-in on this computer, hide. */
export function BrowserPageMenu(props: { view: BrowserFullViewProps; narrow: boolean; onNewTab: () => void }) {
  const { t } = useText();
  const tab = () => props.view.activeTab;
  const [open, setOpen] = createSignal(false);
  useBrowserPageCover(open);
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        class={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        aria-label={t("browser.pageActions")}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <Show when={props.narrow}>
            <DropdownMenu.Item
              disabled={!tab() || tab()?.canGoForward === false}
              onSelect={() => {
                const current = tab();
                if (current) props.view.onNavigate(current.id, "forward");
              }}
            >
              {t("browser.goForward")}
              <BrowserShortcutHint view={props.view} name="forward" />
            </DropdownMenu.Item>
            <Show
              when={browserTabStoppable(tab())}
              fallback={
                <DropdownMenu.Item
                  disabled={!tab()?.url}
                  onSelect={() => {
                    const current = tab();
                    if (current) props.view.onReload(current.id);
                  }}
                >
                  {t("browser.reload")}
                  <BrowserShortcutHint view={props.view} name="reload" />
                </DropdownMenu.Item>
              }
            >
              <DropdownMenu.Item
                onSelect={() => {
                  const current = tab();
                  if (current) props.view.onStop(current.id);
                }}
              >
                {t("browser.stopLoading")}
              </DropdownMenu.Item>
            </Show>
            <DropdownMenu.Separator />
          </Show>
          <DropdownMenu.Item onSelect={props.onNewTab}>
            {t("browser.newTab")}
            <BrowserShortcutHint view={props.view} name="newTab" />
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!props.view.canReopen} onSelect={props.view.onReopenTab}>
            {t("browser.tab.reopenClosed")}
            <BrowserShortcutHint view={props.view} name="reopen" />
          </DropdownMenu.Item>
          <Show when={props.view.canEnterPip !== false}>
            <DropdownMenu.Item disabled={!tab()} onSelect={props.view.onEnterPip}>
              {t("browser.pip.open")}
            </DropdownMenu.Item>
          </Show>
          <Show when={props.view.onSignInLocally}>
            {(signIn) => (
              <DropdownMenu.Item
                disabled={!tab()}
                onSelect={() => {
                  const current = tab();
                  if (current) signIn()(current.id);
                }}
              >
                {t("browser.signIn.local")}
              </DropdownMenu.Item>
            )}
          </Show>
          <Show when={props.view.chromeSignIn}>
            {(chrome) => <ChromeSignInMenu chrome={chrome()} tabId={tab()?.id} />}
          </Show>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={props.view.onBack}>{t("browser.hide")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type ChromeProfiles =
  | { state: "loading" }
  | { state: "ready"; profiles: BrowserChromeProfile[] }
  | { state: "failed"; message: string };

/** Fork: the Chrome profiles of this Mac, read when the submenu opens, so macOS asks only on use. */
function ChromeSignInMenu(props: {
  chrome: NonNullable<BrowserFullViewProps["chromeSignIn"]>;
  tabId: string | undefined;
}) {
  const { t } = useText();
  const [profiles, setProfiles] = createSignal<ChromeProfiles>({ state: "loading" });
  const failure = () => {
    const current = profiles();
    return current.state === "failed" ? current.message : undefined;
  };
  const readyProfiles = () => {
    const current = profiles();
    return current.state === "ready" ? current.profiles : undefined;
  };
  const load = (open: boolean) => {
    if (!open) return;
    setProfiles({ state: "loading" });
    props.chrome.loadProfiles().then(
      (list) => setProfiles({ state: "ready", profiles: list }),
      // The answer says what to do, such as allowing OpenBot to read Chrome's data in System Settings.
      (error: unknown) =>
        setProfiles({
          state: "failed",
          message: error instanceof Error && error.message ? error.message : t("browser.chromeSignIn.failed"),
        }),
    );
  };
  return (
    <DropdownMenu.Sub onOpenChange={load}>
      <DropdownMenu.SubTrigger disabled={!props.tabId}>
        <span>{t("browser.chromeSignIn.menu")}</span>
        <ChevronRight class="agent-context-submenu-chevron size-4" aria-hidden="true" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent class="ui-action-menu agent-context-menu agent-context-submenu">
          <Switch>
            <Match when={profiles().state === "loading"}>
              <DropdownMenu.Item disabled>{t("browser.chromeSignIn.loading")}</DropdownMenu.Item>
            </Match>
            <Match when={failure()}>{(message) => <DropdownMenu.Item disabled>{message()}</DropdownMenu.Item>}</Match>
            <Match when={readyProfiles()}>
              {(list) => (
                <For
                  each={list()}
                  keyed={(profile) => profile.id}
                  fallback={<DropdownMenu.Item disabled>{t("browser.chromeSignIn.empty")}</DropdownMenu.Item>}
                >
                  {(profile) => (
                    <DropdownMenu.Item
                      onSelect={() => {
                        if (props.tabId) props.chrome.onImport(props.tabId, profile());
                      }}
                    >
                      {profile().name}
                    </DropdownMenu.Item>
                  )}
                </For>
              )}
            </Match>
          </Switch>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
