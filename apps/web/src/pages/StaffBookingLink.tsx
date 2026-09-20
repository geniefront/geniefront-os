import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spinner } from "@heroui/react";
import { useSession } from "@/lib/session";
import { apiGet, ApiError } from "@/lib/api";
import { useLanguage } from "@/LanguageContext";
export function StaffBookingLink() {
  const { code = "" } = useParams(),
    navigate = useNavigate(),
    session = useSession(),
    { t } = useLanguage();
  const [error, setError] = useState(false);
  const members = session.locations.map((l) => l.membershipId).join(",");
  useEffect(() => {
    let active = true;
    setError(false);
    void (async () => {
      if (!/^[a-f0-9]{16}$/.test(code)) {
        setError(true);
        return;
      }
      for (const membershipId of members.split(",").filter(Boolean)) {
        try {
          const target = await apiGet<{
            appointmentId: string;
            locationId: string;
          }>(`/v1/desk/booking-links/${code}`, membershipId);
          if (!active) return;
          session.selectMembership(membershipId, "admin");
          navigate(
            `/schedule?appointmentId=${target.appointmentId}&locationId=${target.locationId}`,
            { replace: true },
          );
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) {
            if (active) setError(true);
            return;
          }
        }
      }
      if (active) setError(true);
    })();
    return () => {
      active = false;
    };
  }, [code, members, navigate, session.selectMembership]);
  return (
    <div className="grid min-h-64 place-items-center p-6">
      {error ? <p role="alert">{t("bookingLinkUnavailable")}</p> : <Spinner />}
    </div>
  );
}
