import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { editCustomHeadersFlow } from './customHeaders';
import { probeAllLocalEndpoints, KNOWN_LOCAL_ENDPOINTS } from '../discovery/endpointDiscovery';

/**
 * Prompt user to pick from auto-detected local servers, standard presets, or enter a custom URL.
 */
async function pickServerUrl(currentUrl: string): Promise<string | undefined> {
  const discovered = await probeAllLocalEndpoints();

  interface ServerQuickPickItem extends vscode.QuickPickItem {
    url?: string;
    isCustom?: boolean;
  }

  const items: ServerQuickPickItem[] = [];

  if (discovered.length > 0) {
    items.push({
      label: 'Detected Local Servers',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const d of discovered) {
      items.push({
        label: `$(vm-active) ${d.label}`,
        description: d.url,
        detail: `Auto-detected active server on ${d.url}`,
        url: d.url,
      });
    }
  }

  items.push({
    label: 'Standard Presets',
    kind: vscode.QuickPickItemKind.Separator,
  });
  for (const preset of KNOWN_LOCAL_ENDPOINTS) {
    items.push({
      label: preset.name,
      description: preset.url,
      url: preset.url,
    });
  }

  items.push({
    label: 'Custom',
    kind: vscode.QuickPickItemKind.Separator,
  });
  items.push({
    label: '$(edit) Custom URL...',
    description: `Current: ${currentUrl}`,
    isCustom: true,
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Select Inference Server URL',
    placeHolder: 'Select a detected server or enter a custom URL',
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  if (selected.isCustom) {
    return await vscode.window.showInputBox({
      title: 'LLM Gateway — Custom Server URL',
      prompt: 'Enter the inference server URL (OpenAI-compatible endpoint)',
      value: currentUrl,
      placeHolder: 'http://127.0.0.1:9931',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          new URL(value);
          return undefined;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });
  }

  return selected.url;
}

/**
 * "Configure Server" flow — triggered by the "Add Models..." dropdown via the
 * managementCommand contribution. Prompts for server URL (stored in
 * workspace/user settings) and API key (stored in SecretStorage, issue #28).
 * Refreshes the model list when done.
 */
export async function configureServerFlow(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const currentUrl = config.get<string>('serverUrl', 'http://localhost:8000');

  const url = await pickServerUrl(currentUrl);
  if (url === undefined) { return; } // cancelled

  const apiKey = await vscode.window.showInputBox({
    title: 'LLM Gateway — API Key',
    prompt: 'Enter the API key — saved to VS Code\'s secret storage. Leave empty to clear.',
    password: true,
    placeHolder: 'Optional',
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) { return; } // cancelled

  // Let the user choose Workspace vs. User scope so different VS Code
  // windows can point at different inference servers (issue #23). Only
  // applies to `serverUrl` — the API key is always global because
  // SecretStorage isn't workspace-aware.
  const target = await pickConfigurationTarget(config);
  if (target === undefined) { return; } // cancelled

  await config.update('serverUrl', url, target);
  await provider.setApiKey(apiKey);

  // The config-change listener handles reloadConfig + model refresh
  // automatically, but we also refresh the status bar here.
  provider.invalidateModelCache();
  provider.refreshModels();
  await refreshStatusBar();

  await offerAdvancedSettings(provider);
}

/**
 * After the basic Configure Server flow, offer the user a chance to edit
 * custom headers (kept in SecretStorage, issue #28) or jump to the Settings
 * UI for the remaining non-secret options.
 */
async function offerAdvancedSettings(provider: GatewayProvider): Promise<void> {
  const completePick: vscode.QuickPickItem = {
    label: 'Complete',
    description: 'Finish configuration',
  };
  const headersPick: vscode.QuickPickItem = {
    label: 'Edit custom headers...',
    description: 'Add or remove HTTP headers (stored in secret storage)',
  };
  const advancedPick: vscode.QuickPickItem = {
    label: 'Edit advanced settings...',
    description: 'Extra model options, timeouts, logging',
  };

  const pick = await vscode.window.showQuickPick(
    [completePick, headersPick, advancedPick],
    {
      title: 'LLM Gateway — Configuration saved',
      placeHolder: 'Done, or continue to advanced options?',
      ignoreFocusOut: true,
    }
  );
  if (pick === headersPick) {
    await editCustomHeadersFlow(provider);
  } else if (pick === advancedPick) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'github.copilot.llm-gateway'
    );
  }
}

/**
 * Asks the user whether to save settings to Workspace or User (Global) scope.
 * Returns undefined if cancelled, or skips the prompt and returns Global when
 * no workspace folder is open (the only meaningful scope in that case).
 *
 * Defaults the highlighted option to whichever scope already has a value, and
 * otherwise prefers Workspace when a folder is open — most users hitting this
 * picker want per-window configuration (issue #23).
 */
async function pickConfigurationTarget(
  config: vscode.WorkspaceConfiguration
): Promise<vscode.ConfigurationTarget | undefined> {
  const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (!hasWorkspaceFolder) {
    return vscode.ConfigurationTarget.Global;
  }

  const inspection = config.inspect('serverUrl');
  const workspacePick: vscode.QuickPickItem = {
    label: 'Workspace Settings',
    description: inspection?.workspaceValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to this workspace only — different VS Code windows can use different servers.',
  };
  const globalPick: vscode.QuickPickItem = {
    label: 'User Settings (Global)',
    description: inspection?.globalValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to all VS Code windows.',
  };

  const items = inspection?.globalValue !== undefined && inspection?.workspaceValue === undefined
    ? [globalPick, workspacePick]
    : [workspacePick, globalPick];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Save settings to',
    placeHolder: 'Choose where these settings should apply',
    ignoreFocusOut: true,
  });
  if (!pick) { return undefined; }

  return pick === workspacePick
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
