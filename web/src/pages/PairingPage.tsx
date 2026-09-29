import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Check, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { Badge } from "@/ui";
import { Button } from "@/ui";
import { Spinner } from "@/ui";
import { H2 } from "@/ui";
import { api } from "@/lib/api";
import type { PairingResponse, PairingUser } from "@/lib/api";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useToast } from "@/ui";
import { useConfirmDelete } from "@/ui";
import { Toast } from "@/ui";
import { Card, CardContent } from "@/ui";
import { usePageHeader } from "@/contexts/usePageHeader";
import { errorMessage } from "@/lib/api-error";

function getUserKey(user: PairingUser): string {
  return `${user.platform}:${user.user_id}`;
}

function splitUserKey(key: string): { platform: string; user_id: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { platform: "", user_id: key };
  return { platform: key.slice(0, idx), user_id: key.slice(idx + 1) };
}

function getUserLabel(user: PairingUser): string {
  return user.user_name || user.user_id;
}

export default function PairingPage() {
  const [pending, setPending] = useState<PairingUser[]>([]);
  const [approved, setApproved] = useState<PairingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  const loadPairing = useCallback(() => {
    api
      .getPairing()
      .then((res: PairingResponse) => {
        setPending(res.pending);
        setApproved(res.approved);
      })
      .catch(() => showToast("Failed to load pairing requests", "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    loadPairing();
  }, [loadPairing]);

  const handleApprove = async (user: PairingUser) => {
    if (!user.request_id) {
      showToast("Missing pairing request", "error");
      return;
    }
    const key = getUserKey(user);
    setApproving(key);
    try {
      await api.approvePairing(user.platform, user.request_id);
      showToast(`Approved: "${getUserLabel(user)}"`, "success");
      loadPairing();
    } catch (e) {
      showToast(`Could not approve the pairing request: ${errorMessage(e)}`, "error");
    } finally {
      setApproving(null);
    }
  };

  const handleClearPending = async () => {
    if (!window.confirm("Clear all pending pairing requests?")) return;
    setClearing(true);
    try {
      const res = await api.clearPendingPairing();
      showToast(`Cleared ${res.cleared} pending request(s)`, "success");
      loadPairing();
    } catch (e) {
      showToast(`Could not clear pending requests: ${errorMessage(e)}`, "error");
    } finally {
      setClearing(false);
    }
  };

  const userRevoke = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const { platform, user_id } = splitUserKey(key);
        const user = approved.find((u) => getUserKey(u) === key);
        try {
          await api.revokePairing(platform, user_id);
          showToast(
            `Revoked: "${user ? getUserLabel(user) : user_id}"`,
            "success",
          );
          loadPairing();
        } catch (e) {
          showToast(`Could not revoke access: ${errorMessage(e)}`, "error");
          throw e;
        }
      },
      [approved, loadPairing, showToast],
    ),
  });

  // Put "Clear pending" button in page header
  useLayoutEffect(() => {
    setEnd(
      <Button
        className="text-uppercase"
        size="sm"
        onClick={handleClearPending}
        disabled={clearing}
        prefix={clearing ? <Spinner /> : <Trash2 className="icon-md" />}
      >
        Clear pending
      </Button>,
    );
    return () => {
      setEnd(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setEnd, clearing]);

  if (loading) {
    return (
      <div className="d-flex align-items-center justify-content-center py-24">
        <Spinner className="fs-3 text-primary" />
      </div>
    );
  }

  const pendingRevokeUser = userRevoke.pendingId
    ? approved.find((u) => getUserKey(u) === userRevoke.pendingId)
    : null;

  return (
    <div className="d-flex flex-column gap-6">
      <Toast toast={toast} />

      <DeleteConfirmDialog
        open={userRevoke.isOpen}
        onCancel={userRevoke.cancel}
        onConfirm={userRevoke.confirm}
        title="Revoke access"
        description={
          pendingRevokeUser
            ? `"${getUserLabel(pendingRevokeUser)}" will lose access. This cannot be undone.`
            : "This user will lose access. This cannot be undone."
        }
        confirmLabel="Revoke"
        loading={userRevoke.isDeleting}
      />

      {/* Pending requests */}
      <div className="d-flex flex-column gap-3">
        <H2
          variant="sm"
          className="d-flex align-items-center gap-2 text-body-secondary"
        >
          <Users className="icon-md" />
          Pending requests ({pending.length})
        </H2>

        {pending.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center fs-6 text-body-secondary">
              No pending pairing requests
            </CardContent>
          </Card>
        )}

        {pending.map((user) => {
          const key = getUserKey(user);
          return (
            <Card key={key}>
              <CardContent className="d-flex align-items-start gap-4 py-4">
                <div className="flex-grow-1 min-w-0">
                  <div className="d-flex align-items-center gap-2 mb-1">
                    <Badge tone="outline">{user.platform}</Badge>
                    <span className="fw-medium fs-6 text-truncate">
                      {getUserLabel(user)}
                    </span>
                  </div>
                  <div className="d-flex align-items-center gap-4 fs-6 text-body-secondary">
                    <span className="text-truncate">{user.user_id}</span>
                    {typeof user.age_minutes === "number" && (
                      <span>{user.age_minutes}m ago</span>
                    )}
                  </div>
                </div>

                <div className="d-flex align-items-center gap-1 flex-shrink-0">
                  <Button
                    size="sm"
                    className="text-uppercase"
                    onClick={() => handleApprove(user)}
                    disabled={approving === key || !user.request_id}
                    prefix={
                      approving === key ? (
                        <Spinner />
                      ) : (
                        <Check className="icon-md" />
                      )
                    }
                  >
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Approved users */}
      <div className="d-flex flex-column gap-3">
        <H2
          variant="sm"
          className="d-flex align-items-center gap-2 text-body-secondary"
        >
          <ShieldCheck className="icon-md" />
          Approved users ({approved.length})
        </H2>

        {approved.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center fs-6 text-body-secondary">
              No approved users
            </CardContent>
          </Card>
        )}

        {approved.map((user) => {
          const key = getUserKey(user);
          return (
            <Card key={key}>
              <CardContent className="d-flex align-items-start gap-4 py-4">
                <div className="flex-grow-1 min-w-0">
                  <div className="d-flex align-items-center gap-2 mb-1">
                    <Badge tone="outline">{user.platform}</Badge>
                    <span className="fw-medium fs-6 text-truncate">
                      {user.user_id}
                    </span>
                  </div>
                  {user.user_name && (
                    <div className="fs-6 text-body-secondary text-truncate">
                      {user.user_name}
                    </div>
                  )}
                </div>

                <div className="d-flex align-items-center gap-1 flex-shrink-0">
                  <Button
                    ghost
                    size="icon"
                    title="Revoke"
                    aria-label="Revoke"
                    className="text-danger"
                    onClick={() => userRevoke.requestDelete(key)}
                  >
                    <X />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
