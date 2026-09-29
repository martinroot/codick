import { useEffect, useState, useCallback, useRef } from "react";
import {
  ShieldCheck,
  ShieldOff,
  ExternalLink,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { api, type OAuthProvider } from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { CopyButton } from "@nous-research/ui/ui/components/command-block";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { OAuthLoginModal } from "@/components/OAuthLoginModal";
import { useI18n } from "@/i18n";
import { errorMessage } from "@/lib/api-error";

interface Props {
  onError?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
}

function formatExpiresAt(
  expiresAt: string | null | undefined,
  expiresInTemplate: string,
): string | null {
  if (!expiresAt) return null;
  try {
    const dt = new Date(expiresAt);
    if (Number.isNaN(dt.getTime())) return null;
    const now = Date.now();
    const diff = dt.getTime() - now;
    if (diff < 0) return "expired";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return expiresInTemplate.replace("{time}", `${mins}m`);
    const hours = Math.floor(mins / 60);
    if (hours < 24) return expiresInTemplate.replace("{time}", `${hours}h`);
    const days = Math.floor(hours / 24);
    return expiresInTemplate.replace("{time}", `${days}d`);
  } catch {
    return null;
  }
}

export function OAuthProvidersCard({ onError, onSuccess }: Props) {
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<OAuthProvider | null>(null);
  const [disconnectTarget, setDisconnectTarget] =
    useState<OAuthProvider | null>(null);
  const { t } = useI18n();

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .getOAuthProviders()
      .then((resp) => setProviders(resp.providers))
      .catch((e) => onErrorRef.current?.(`Failed to load providers: ${errorMessage(e)}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDisconnect = async (provider: OAuthProvider) => {
    setBusyId(provider.id);
    setDisconnectTarget(null);
    try {
      await api.disconnectOAuthProvider(provider.id);
      onSuccess?.(`${provider.name} ${t.oauth.disconnect.toLowerCase()}ed`);
      refresh();
    } catch (e) {
      onError?.(`${t.oauth.disconnect} failed: ${errorMessage(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const connectedCount =
    providers?.filter((p) => p.status.logged_in).length ?? 0;
  const totalCount = providers?.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="d-flex align-items-center justify-content-between">
          <div className="d-flex align-items-center gap-2">
            <ShieldCheck className="icon-lg text-body-secondary" />
            <CardTitle className="fs-6">
              {t.oauth.providerLogins}
            </CardTitle>
          </div>
          <Button
            ghost
            size="icon"
            className="text-body-secondary hover:text-foreground"
            onClick={refresh}
            disabled={loading}
            aria-label={t.common.refresh}
          >
            {loading ? <Spinner /> : <RefreshCw />}
          </Button>
        </div>
        <CardDescription>
          {t.oauth.description
            .replace("{connected}", String(connectedCount))
            .replace("{total}", String(totalCount))}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && providers === null && (
          <div className="d-flex align-items-center justify-content-center py-8">
            <Spinner className="fs-4 text-primary" />
          </div>
        )}
        {providers && providers.length === 0 && (
          <p className="fs-6 text-body-secondary text-center py-8">
            {t.oauth.noProviders}
          </p>
        )}
        <div className="d-flex flex-column divide-y divide-border">
          {providers?.map((p) => {
            const expiresLabel = formatExpiresAt(
              p.status.expires_at,
              t.oauth.expiresIn,
            );
            const isBusy = busyId === p.id;
            return (
              <div
                key={p.id}
                className="d-flex align-items-center justify-content-between gap-4 py-3"
              >
                <div className="d-flex align-items-start gap-3 min-w-0 flex-grow-1">
                  {p.status.logged_in ? (
                    <ShieldCheck className="icon-lg text-success flex-shrink-0 mt-1" />
                  ) : (
                    <ShieldOff className="icon-lg text-body-secondary flex-shrink-0 mt-1" />
                  )}
                  <div className="d-flex flex-column min-w-0 gap-0.5">
                    <div className="d-flex align-items-center gap-2 flex-wrap">
                      <span className="fw-medium fs-6">{p.name}</span>
                      <Badge
                        tone="outline"
                        className="fs-6 tracking-wide"
                      >
                        {t.oauth.flowLabels[p.flow]}
                      </Badge>
                      {p.status.logged_in && (
                        <Badge tone="success" className="fs-6">
                          {t.oauth.connected}
                        </Badge>
                      )}
                      {expiresLabel === "expired" && (
                        <Badge tone="destructive" className="fs-6">
                          {t.oauth.expired}
                        </Badge>
                      )}
                      {expiresLabel && expiresLabel !== "expired" && (
                        <Badge tone="outline" className="fs-6">
                          {expiresLabel}
                        </Badge>
                      )}
                    </div>
                    {p.status.logged_in && p.status.token_preview && (
                      <span className="text-truncate fs-6 font-monospace text-body-secondary">
                        <span className="text-body-tertiary">token </span>
                        {p.status.token_preview}
                        {p.status.source_label && (
                          <span className="text-body-tertiary">
                            {"  "}
                            · {p.status.source_label}
                          </span>
                        )}
                      </span>
                    )}
                    {!p.status.logged_in && (
                      <>
                        <span className="fs-6 text-body-secondary">
                          {t.oauth.notConnected.split("{command}")[0].trimEnd()}
                          {t.oauth.notConnected.split("{command}")[1] ?? ""}
                        </span>

                        <div className="d-flex min-w-0 flex-wrap align-items-center gap-2">
                          <code className="font-courier text-truncate fs-6 opacity-60">
                            {p.cli_command}
                          </code>

                          <CopyButton
                            text={p.cli_command}
                            label={t.oauth.cli}
                            copiedLabel={t.oauth.copied}
                          />
                        </div>
                      </>
                    )}
                    {p.status.error && (
                      <span className="fs-6 text-danger">
                        {p.status.error}
                      </span>
                    )}
                  </div>
                </div>

                <div className="d-flex align-items-center gap-2 flex-shrink-0">
                  {p.docs_url && (
                    <a
                      href={p.docs_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="d-inline-flex"
                      title={`Open ${p.name} docs`}
                    >
                      <Button ghost size="icon">
                        <ExternalLink />
                      </Button>
                    </a>
                  )}
                  {!p.status.logged_in && p.flow !== "external" && (
                    <Button
                      size="sm"
                      className="text-uppercase"
                      onClick={() => setLoginFor(p)}
                    >
                      {t.oauth.login}
                    </Button>
                  )}
                  {p.status.logged_in && p.flow !== "external" && (
                    <Button
                      size="sm"
                      outlined
                      className="text-uppercase"
                      onClick={() => setDisconnectTarget(p)}
                      disabled={isBusy}
                      prefix={isBusy ? <Spinner /> : undefined}
                    >
                      {t.oauth.disconnect}
                    </Button>
                  )}
                  {p.status.logged_in && p.flow === "external" && (
                    <span className="fs-6 text-body-tertiary fst-italic px-2">
                      <Terminal className="icon-sm d-inline mr-0.5" />
                      {t.oauth.managedExternally}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
      {loginFor && (
        <OAuthLoginModal
          provider={loginFor}
          onClose={() => {
            setLoginFor(null);
            refresh();
          }}
          onSuccess={(msg) => onSuccess?.(msg)}
          onError={(msg) => onError?.(msg)}
        />
      )}
      <ConfirmDialog
        open={disconnectTarget !== null}
        onCancel={() => setDisconnectTarget(null)}
        onConfirm={() => {
          if (disconnectTarget) void handleDisconnect(disconnectTarget);
        }}
        title={`${t.oauth.disconnect} ${disconnectTarget?.name ?? ""}?`}
        description={`This will remove the stored OAuth tokens for ${disconnectTarget?.name ?? "this provider"}. You will need to re-authenticate to use it again.`}
        destructive
        confirmLabel={t.oauth.disconnect}
      />
    </Card>
  );
}
