import React from 'react';
import { RotateCcw } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export interface BodyMapValue {
  focus: string[];
  avoid: string[];
}

interface BodyMapSelectorProps {
  value?: BodyMapValue;
  onChange?: (val: BodyMapValue) => void;
  readonly?: boolean;
}

export const BodyMapSelector: React.FC<BodyMapSelectorProps> = ({
  value = { focus: [], avoid: [] },
  onChange,
  readonly = false,
}) => {
  const { t } = useLanguage();

  const focusSet = new Set(value.focus);
  const avoidSet = new Set(value.avoid);

  const getPartState = (partKey: string): 'focus' | 'avoid' | 'none' => {
    if (avoidSet.has(partKey)) return 'avoid';
    if (focusSet.has(partKey)) return 'focus';
    return 'none';
  };

  const handleTogglePart = (partKey: string) => {
    if (readonly || !onChange) return;

    const nextFocus = new Set(value.focus);
    const nextAvoid = new Set(value.avoid);

    // 状态轮转: none -> focus (绿) -> avoid (红) -> none
    if (nextFocus.has(partKey)) {
      nextFocus.delete(partKey);
      nextAvoid.add(partKey);
    } else if (nextAvoid.has(partKey)) {
      nextAvoid.delete(partKey);
    } else {
      nextFocus.add(partKey);
    }

    onChange({
      focus: Array.from(nextFocus),
      avoid: Array.from(nextAvoid),
    });
  };

  const handleClearAll = () => {
    if (readonly || !onChange) return;
    onChange({ focus: [], avoid: [] });
  };

  const partClasses = (partKey: string) => {
    const state = getPartState(partKey);
    const base = 'transition-all duration-200 cursor-pointer stroke-[1.5] ';
    if (state === 'focus') {
      return base + 'fill-emerald-300 stroke-emerald-600 hover:fill-emerald-400 drop-shadow-xs';
    }
    if (state === 'avoid') {
      return base + 'fill-rose-300 stroke-rose-600 hover:fill-rose-400 drop-shadow-xs';
    }
    return base + 'fill-slate-100 stroke-slate-400 hover:fill-slate-200 hover:stroke-slate-600';
  };

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 space-y-4 shadow-sm select-none">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <h4 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span className="text-teal-600">🧍</span>
            <span>{t('health.bodyMapTitle')}</span>
          </h4>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('health.bodyMapSubtitle')}
          </p>
        </div>

        {!readonly && (value.focus.length > 0 || value.avoid.length > 0) && (
          <button
            type="button"
            onClick={handleClearAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-600 transition-colors self-start sm:self-auto"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{t('common.clear')}</span>
          </button>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2 items-center">
        {/* 正面 Front */}
        <div className="flex flex-col items-center justify-center bg-slate-50/70 p-4 rounded-2xl border border-slate-200/80 shadow-inner">
          <span className="text-xs font-bold text-slate-700 mb-2 px-3 py-1 bg-white rounded-full border border-slate-200 shadow-2xs">
            {t('health.bodyFront')}
          </span>
          <svg viewBox="0 0 200 370" className="w-40 sm:w-48 h-auto drop-shadow-xs">
            {/* Head & Face */}
            <ellipse
              cx="100"
              cy="30"
              rx="16"
              ry="22"
              className={partClasses('Head/Face')}
              onClick={() => handleTogglePart('Head/Face')}
              data-testid="part-head"
            />
            {/* Neck / Throat */}
            <rect
              x="93"
              y="53"
              width="14"
              height="12"
              rx="2"
              className={partClasses('Neck/Throat')}
              onClick={() => handleTogglePart('Neck/Throat')}
            />
            {/* Shoulders */}
            <path
              d="M60,67 L88,67 L88,85 L52,85 Z"
              className={partClasses('Left Shoulder')}
              onClick={() => handleTogglePart('Left Shoulder')}
            />
            <path
              d="M112,67 L140,67 L148,85 L112,85 Z"
              className={partClasses('Right Shoulder')}
              onClick={() => handleTogglePart('Right Shoulder')}
            />
            {/* Chest */}
            <rect
              x="76"
              y="68"
              width="48"
              height="36"
              rx="4"
              className={partClasses('Chest')}
              onClick={() => handleTogglePart('Chest')}
            />
            {/* Abdomen / Stomach */}
            <rect
              x="78"
              y="106"
              width="44"
              height="38"
              rx="4"
              className={partClasses('Abdomen')}
              onClick={() => handleTogglePart('Abdomen')}
            />
            {/* Arms */}
            <rect
              x="46"
              y="88"
              width="14"
              height="55"
              rx="6"
              className={partClasses('Left Arm')}
              onClick={() => handleTogglePart('Left Arm')}
            />
            <rect
              x="140"
              y="88"
              width="14"
              height="55"
              rx="6"
              className={partClasses('Right Arm')}
              onClick={() => handleTogglePart('Right Arm')}
            />
            {/* Forearms */}
            <rect
              x="42"
              y="146"
              width="12"
              height="45"
              rx="5"
              className={partClasses('Left Forearm')}
              onClick={() => handleTogglePart('Left Forearm')}
            />
            <rect
              x="146"
              y="146"
              width="12"
              height="45"
              rx="5"
              className={partClasses('Right Forearm')}
              onClick={() => handleTogglePart('Right Forearm')}
            />
            {/* Pelvis / Hips */}
            <polygon
              points="74,146 126,146 120,180 80,180"
              className={partClasses('Pelvis/Hips')}
              onClick={() => handleTogglePart('Pelvis/Hips')}
            />
            {/* Thighs */}
            <rect
              x="76"
              y="184"
              width="20"
              height="65"
              rx="7"
              className={partClasses('Left Thigh')}
              onClick={() => handleTogglePart('Left Thigh')}
            />
            <rect
              x="104"
              y="184"
              width="20"
              height="65"
              rx="7"
              className={partClasses('Right Thigh')}
              onClick={() => handleTogglePart('Right Thigh')}
            />
            {/* Knees */}
            <ellipse
              cx="86"
              cy="256"
              rx="9"
              ry="7"
              className={partClasses('Left Knee')}
              onClick={() => handleTogglePart('Left Knee')}
            />
            <ellipse
              cx="114"
              cy="256"
              rx="9"
              ry="7"
              className={partClasses('Right Knee')}
              onClick={() => handleTogglePart('Right Knee')}
            />
            {/* Shins */}
            <rect
              x="78"
              y="268"
              width="16"
              height="65"
              rx="6"
              className={partClasses('Left Shin')}
              onClick={() => handleTogglePart('Left Shin')}
            />
            <rect
              x="106"
              y="268"
              width="16"
              height="65"
              rx="6"
              className={partClasses('Right Shin')}
              onClick={() => handleTogglePart('Right Shin')}
            />
            {/* Feet */}
            <path
              d="M74,336 L94,336 L98,356 L70,356 Z"
              className={partClasses('Left Foot')}
              onClick={() => handleTogglePart('Left Foot')}
            />
            <path
              d="M106,336 L126,336 L130,356 L102,356 Z"
              className={partClasses('Right Foot')}
              onClick={() => handleTogglePart('Right Foot')}
            />
          </svg>
        </div>

        {/* 背面 Back */}
        <div className="flex flex-col items-center justify-center bg-slate-50/70 p-4 rounded-2xl border border-slate-200/80 shadow-inner">
          <span className="text-xs font-bold text-slate-700 mb-2 px-3 py-1 bg-white rounded-full border border-slate-200 shadow-2xs">
            {t('health.bodyBack')}
          </span>
          <svg viewBox="0 0 200 370" className="w-40 sm:w-48 h-auto drop-shadow-xs">
            {/* Occiput / Back of Head */}
            <ellipse
              cx="100"
              cy="30"
              rx="16"
              ry="22"
              className={partClasses('Occiput/Back of Head')}
              onClick={() => handleTogglePart('Occiput/Back of Head')}
            />
            {/* Upper Neck */}
            <rect
              x="93"
              y="53"
              width="14"
              height="12"
              rx="2"
              className={partClasses('Upper Neck')}
              onClick={() => handleTogglePart('Upper Neck')}
            />
            {/* Upper Back & Trapezius */}
            <path
              d="M60,67 L140,67 L128,106 L72,106 Z"
              className={partClasses('Upper Back & Trapezius')}
              onClick={() => handleTogglePart('Upper Back & Trapezius')}
            />
            {/* Lower Back / Lumbar */}
            <rect
              x="76"
              y="108"
              width="48"
              height="38"
              rx="4"
              className={partClasses('Lower Back')}
              onClick={() => handleTogglePart('Lower Back')}
            />
            {/* Glutes / Hips */}
            <ellipse
              cx="87"
              cy="164"
              rx="16"
              ry="18"
              className={partClasses('Left Glute')}
              onClick={() => handleTogglePart('Left Glute')}
            />
            <ellipse
              cx="113"
              cy="164"
              rx="16"
              ry="18"
              className={partClasses('Right Glute')}
              onClick={() => handleTogglePart('Right Glute')}
            />
            {/* Hamstrings */}
            <rect
              x="76"
              y="188"
              width="20"
              height="65"
              rx="7"
              className={partClasses('Left Hamstring')}
              onClick={() => handleTogglePart('Left Hamstring')}
            />
            <rect
              x="104"
              y="188"
              width="20"
              height="65"
              rx="7"
              className={partClasses('Right Hamstring')}
              onClick={() => handleTogglePart('Right Hamstring')}
            />
            {/* Calves */}
            <rect
              x="78"
              y="262"
              width="16"
              height="70"
              rx="6"
              className={partClasses('Left Calf')}
              onClick={() => handleTogglePart('Left Calf')}
            />
            <rect
              x="106"
              y="262"
              width="16"
              height="70"
              rx="6"
              className={partClasses('Right Calf')}
              onClick={() => handleTogglePart('Right Calf')}
            />
            {/* Heels / Soles */}
            <ellipse
              cx="86"
              cy="344"
              rx="10"
              ry="12"
              className={partClasses('Left Heel/Sole')}
              onClick={() => handleTogglePart('Left Heel/Sole')}
            />
            <ellipse
              cx="114"
              cy="344"
              rx="10"
              ry="12"
              className={partClasses('Right Heel/Sole')}
              onClick={() => handleTogglePart('Right Heel/Sole')}
            />
          </svg>
        </div>
      </div>
    </div>
  );
};
