import { useEffect, useRef, useState } from "react";
import { ExternalLink, X, Check, Copy } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api, type OAuthProvider, type OAuthStartResponse } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Input } from "@nous-research/ui/ui/components/input";
import { useI18n } from "@/i18n";
import { cn, themedBody } from "@/lib/utils";
import { errorMessage } from "@/lib/api-error";

interface Props {
  provider: OAuthProvider;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

type Phase =
  | "idle"
  | "starting"
  | "awaiting_user"
  | "submitting"
  | "polling"
  | "approved"
  | "error";

export function OAuthLoginModal({ provider, onClose, onSuccess }: Props) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [start, setStart] = useState<OAuthStartResponse | null>(null);
  const [pkceCode, setPkceCode] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const isMounted = useRef(true);
  const pollTimer = useRef<number | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const { t } = useI18n();

  // Initiate flow on mount
  useEffect(() => {
    isMounted.current = true;
    api
      .startOAuthLogin(provider.id)
      .then((resp) => {
        if (!isMounted.current) return;
        setStart(resp);
        setSecondsLeft(resp.expires_in);
        setPhase(resp.flow === "device_code" ? "polling" : "awaiting_user");
        if (resp.flow === "pkce") {
          window.open(resp.auth_url, "_blank", "noopener,noreferrer");
        } else {
          window.open(resp.verification_url, "_blank", "noopener,noreferrer");
        }
      })
      .catch((e) => {
        if (!isMounted.current) return;
        setPhase("error");
        setErrorMsg(`Failed to start login: ${errorMessage(e)}`);
      });
    return () => {
      isMounted.current = false;
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
      if (copyResetTimer.current !== null)
        window.clearTimeout(copyResetTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the sign-in window lapses locally, the backend poller usually has
  // the real story (e.g. "Portal sign-in is required before the device code
  // can be approved") — but its next poll tick is up to 2s away. Rather than
  // preempt it with a bare "expired", ask the poll endpoint once, then fall
  // back to guidance that names the common cause (sign-in stalled in the
  // opened tab) instead of a dead-end.
  const handleLocalExpiry = async () => {
    if (!isMounted.current) return;
    let backendMessage: string | null = null;
    if (start && start.flow === "device_code") {
      try {
        const resp = await api.pollOAuthSession(provider.id, start.session_id);
        if (resp.error_message) backendMessage = resp.error_message;
        else if (resp.status === "pending") {
          // Still pending server-side: the local countdown fired early
          // (clock skew or a stalled tab). Keep the session alive for the
          // poller instead of killing it with a wrong "expired".
          if (isMounted.current) setPhase("polling");
          return;
        }
      } catch {
        // Poll endpoint unreachable — fall through to generic guidance.
      }
    }
    if (!isMounted.current) return;
    setPhase("error");
    setErrorMsg(backendMessage || t.oauth.sessionExpiredNoError);
  };

  // Tick the countdown down to zero — never further. What happens AT zero
  // is owned by the lapse effect below, so the updater stays pure.
  useEffect(() => {
    if (secondsLeft === null) return;
    if (secondsLeft <= 0) return;
    if (phase === "approved" || phase === "error") return;
    const tick = window.setInterval(() => {
      if (!isMounted.current) return;
      setSecondsLeft((s) => (s !== null && s > 0 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [secondsLeft, phase]);

  useEffect(() => {
    if (secondsLeft !== 0) return;
    if (phase === "approved" || phase === "error") return;
    void handleLocalExpiry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, phase]);

  // Device-code: poll backend every 2s
  useEffect(() => {
    if (!start || start.flow !== "device_code" || phase !== "polling") return;
    const sid = start.session_id;
    pollTimer.current = window.setInterval(async () => {
      try {
        const resp = await api.pollOAuthSession(provider.id, sid);
        if (!isMounted.current) return;
        if (resp.status === "approved") {
          setPhase("approved");
          if (pollTimer.current !== null)
            window.clearInterval(pollTimer.current);
          onSuccess(`${provider.name} connected`);
          window.setTimeout(() => isMounted.current && onClose(), 1500);
        } else if (resp.status !== "pending") {
          setPhase("error");
          setErrorMsg(resp.error_message || `Login ${resp.status}`);
          if (pollTimer.current !== null)
            window.clearInterval(pollTimer.current);
        }
      } catch (e) {
        if (!isMounted.current) return;
        setPhase("error");
        setErrorMsg(`Polling failed: ${errorMessage(e)}`);
        if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
      }
    }, 2000);
    return () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
    };
  }, [start, phase, provider.id, provider.name, onSuccess, onClose]);

  const handleSubmitPkceCode = async () => {
    if (!start || start.flow !== "pkce") return;
    if (!pkceCode.trim()) return;
    setPhase("submitting");
    setErrorMsg(null);
    try {
      const resp = await api.submitOAuthCode(
        provider.id,
        start.session_id,
        pkceCode.trim(),
      );
      if (!isMounted.current) return;
      if (resp.ok && resp.status === "approved") {
        setPhase("approved");
        onSuccess(`${provider.name} connected`);
        window.setTimeout(() => isMounted.current && onClose(), 1500);
      } else {
        setPhase("error");
        setErrorMsg(resp.message || "Token exchange failed");
      }
    } catch (e) {
      if (!isMounted.current) return;
      setPhase("error");
      setErrorMsg(`Submit failed: ${errorMessage(e)}`);
    }
  };

  const handleClose = async () => {
    if (start && phase !== "approved" && phase !== "error") {
      try {
        await api.cancelOAuthSession(start.session_id);
      } catch {
        // ignore
      }
    }
    onClose();
  };

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  };

  const fmtTime = (s: number | null) => {
    if (s === null) return "";
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  const handleCopyDeviceCode = async (code: string) => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = null;
    }
    const copied = await copyTextToClipboard(code);
    if (!isMounted.current) return;
    setCopyStatus(copied ? "copied" : "failed");
    copyResetTimer.current = window.setTimeout(() => {
      if (isMounted.current) setCopyStatus("idle");
      copyResetTimer.current = null;
    }, 2000);
  };

  const deviceCode = start?.flow === "device_code" ? start.user_code : "";
  const verificationUrl =
    start?.flow === "device_code" ? start.verification_url : "";

  return (
    <div
      className="position-fixed top-0 start-0 w-100 h-100 z-[100] d-flex align-items-center justify-content-center bg-background/85 p-4"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="oauth-modal-title"
    >
      <div className={cn(themedBody, "position-relative w-100 max-w-md border border-secondary bg-card shadow-2xl")}>
        <Button
          ghost
          size="icon"
          onClick={handleClose}
          className="position-absolute right-2 top-2 text-body-secondary hover:text-foreground"
          aria-label={t.common.close}
        >
          <X />
        </Button>
        <div className="p-6 d-flex flex-column gap-4">
          <div>
            <H2
              id="oauth-modal-title"
              variant="sm"
              mondwest
              className="ls-wide text-uppercase"
            >
              {t.oauth.connect} {provider.name}
            </H2>
            {secondsLeft !== null &&
              phase !== "approved" &&
              phase !== "error" && (
                <p className="fs-6 text-body-secondary mt-1">
                  {t.oauth.sessionExpires.replace(
                    "{time}",
                    fmtTime(secondsLeft),
                  )}
                </p>
              )}
          </div>

          {phase === "starting" && (
            <div className="d-flex align-items-center gap-3 py-6 fs-6 text-body-secondary">
              <Spinner />
              {t.oauth.initiatingLogin}
            </div>
          )}

          {start?.flow === "pkce" && phase === "awaiting_user" && (
            <>
              <ol className="fs-6 space-y-2 list-decimal list-inside text-body-secondary">
                <li>{t.oauth.pkceStep1}</li>
                <li>{t.oauth.pkceStep2}</li>
                <li>{t.oauth.pkceStep3}</li>
              </ol>
              <div className="d-flex flex-column gap-2">
                <Input
                  value={pkceCode}
                  onChange={(e) => setPkceCode(e.target.value)}
                  placeholder={t.oauth.pasteCode}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmitPkceCode()}
                  autoFocus
                />
                <div className="d-flex align-items-center gap-2 justify-content-between">
                  <a
                    href={
                      (start as Extract<OAuthStartResponse, { flow: "pkce" }>)
                        .auth_url
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="fs-6 text-body-secondary hover:text-foreground d-inline-flex align-items-center gap-1"
                  >
                    <ExternalLink className="icon-sm" />
                    {t.oauth.reOpenAuth}
                  </a>
                  <Button
                    onClick={handleSubmitPkceCode}
                    disabled={!pkceCode.trim()}
                  >
                    {t.oauth.submitCode}
                  </Button>
                </div>
              </div>
            </>
          )}

          {phase === "submitting" && (
            <div className="d-flex align-items-center gap-3 py-6 fs-6 text-body-secondary">
              <Spinner />
              {t.oauth.exchangingCode}
            </div>
          )}

          {start?.flow === "device_code" && phase === "polling" && (
            <>
              <p className="fs-6 text-body-secondary">
                {t.oauth.enterCodePrompt}
              </p>
              <div className="d-flex align-items-center justify-content-between gap-2 border border-secondary bg-secondary/30 p-4">
                <code className="font-monospace fs-3 tracking-widest text-body-emphasis">
                  {deviceCode}
                </code>
                <Button
                  size="sm"
                  outlined
                  className="flex-shrink-0 text-uppercase"
                  onClick={() => void handleCopyDeviceCode(deviceCode)}
                  prefix={
                    copyStatus === "copied" ? (
                      <Check className="icon-md" />
                    ) : (
                      <Copy className="icon-md" />
                    )
                  }
                  aria-label={t.oauth.copyCode}
                >
                  {copyStatus === "copied" ? t.oauth.copied : t.oauth.copyCode}
                </Button>
              </div>
              {copyStatus === "failed" && (
                <p className="fs-6 text-danger">
                  {t.oauth.copyFailed}
                </p>
              )}
              <a
                href={verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="fs-6 text-body-secondary hover:text-foreground d-inline-flex align-items-center gap-1"
              >
                <ExternalLink className="icon-sm" />
                {t.oauth.reOpenVerification}
              </a>
              <div className="d-flex align-items-center gap-2 fs-6 text-body-secondary border-top border-secondary pt-3">
                <Spinner className="fs-6" />
                {t.oauth.waitingAuth}
              </div>
            </>
          )}

          {phase === "approved" && (
            <div className="d-flex align-items-center gap-3 py-6 fs-6 text-success">
              <Check className="icon-lg" />
              {t.oauth.connectedClosing}
            </div>
          )}

          {phase === "error" && (
            <>
              <div className="border border-destructive/30 bg-destructive/10 p-3 fs-6 text-danger">
                {errorMsg || t.oauth.loginFailed}
              </div>
              <div className="d-flex justify-content-end gap-2">
                <Button outlined onClick={handleClose}>
                  {t.common.close}
                </Button>
                <Button
                  onClick={() => {
                    if (start?.session_id) {
                      api.cancelOAuthSession(start.session_id).catch(() => {});
                    }
                    setErrorMsg(null);
                    setStart(null);
                    setPkceCode("");
                    setSecondsLeft(null);
                    setPhase("starting");
                    api
                      .startOAuthLogin(provider.id)
                      .then((resp) => {
                        if (!isMounted.current) return;
                        setStart(resp);
                        setSecondsLeft(resp.expires_in);
                        setPhase(
                          resp.flow === "device_code"
                            ? "polling"
                            : "awaiting_user",
                        );
                        if (resp.flow === "pkce") {
                          window.open(
                            resp.auth_url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        } else {
                          window.open(
                            resp.verification_url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      })
                      .catch((e) => {
                        if (!isMounted.current) return;
                        setPhase("error");
                        setErrorMsg(`${t.common.retry} failed: ${errorMessage(e)}`);
                      });
                  }}
                >
                  {t.common.retry}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
