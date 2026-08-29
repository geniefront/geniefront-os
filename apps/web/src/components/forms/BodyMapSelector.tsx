import React, { useState } from 'react';
import { useLanguage } from '@/LanguageContext';
import { ShieldAlert, Sparkles, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { bodyPartText, publicText } from '@/features/forms/publicCopy';

export interface BodyPartItem {
  id: string;
  name: Record<string, string>;
  state: 'focus' | 'avoid' | 'none';
}

export interface BodyMapValue {
  focus: string[]; // List of part names in EN or IDs
  avoid: string[]; // List of part names in EN or IDs
}

interface BodyMapSelectorProps {
  value?: BodyMapValue;
  onChange?: (val: BodyMapValue) => void;
  readonly?: boolean;
  activeLanguage?: string;
}

export function BodyMapSelector({
  value = { focus: [], avoid: [] },
  onChange,
  readonly = false,
  activeLanguage,
}: BodyMapSelectorProps) {
  const { language } = useLanguage();
  const lang = activeLanguage || language;

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
      return base + 'fill-emerald-300 stroke-emerald-600 hover:fill-emerald-400';
    }
    if (state === 'avoid') {
      return base + 'fill-rose-300 stroke-rose-600 hover:fill-rose-400';
    }
    return base + 'fill-slate-100 stroke-slate-400 hover:fill-slate-200 hover:stroke-slate-600';
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5 space-y-4 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200/80 pb-3">
        <div>
          <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
            <span className="text-teal-600">🧍</span>
            <span>{publicText('bodyMapTitle', lang)}</span>
          </h4>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {publicText('bodyMapInstructions', lang)}
          </p>
        </div>

        {!readonly && (value.focus.length > 0 || value.avoid.length > 0) && (
          <button
            type="button"
            onClick={handleClearAll}
            className="flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600 self-start sm:self-auto"
          >
            <RotateCcw className="h-3 w-3" />
            {publicText('resetMarks', lang)}
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_260px] items-center">
        {/* SVG 人体正反面图 */}
        <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-10 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-inner">
          {/* 正面 Front */}
          <div className="text-center">
            <span className="text-[11px] font-bold text-slate-700 block mb-2">{publicText('front', lang)}</span>
            <svg viewBox="0 0 200 370" className="w-36 sm:w-44 h-auto drop-shadow-xs">
              {/* Head & Neck */}
              <ellipse
                cx="100"
                cy="30"
                rx="16"
                ry="22"
                className={partClasses('Head/Face')}
                onClick={() => handleTogglePart('Head/Face')}
              />
              <path
                d="M 92,48 L 108,48 L 110,60 L 90,60 Z"
                className={partClasses('Neck/Throat')}
                onClick={() => handleTogglePart('Neck/Throat')}
              />
              {/* Torso Front */}
              <path
                d="M 70,60 L 130,60 C 145,70 145,100 130,105 L 70,105 C 55,100 55,70 70,60 Z"
                className={partClasses('Chest')}
                onClick={() => handleTogglePart('Chest')}
              />
              <path
                d="M 72,107 L 128,107 C 125,130 125,150 122,155 L 78,155 C 75,150 75,130 72,107 Z"
                className={partClasses('Abdomen')}
                onClick={() => handleTogglePart('Abdomen')}
              />
              <path
                d="M 78,157 L 122,157 C 130,180 115,200 100,200 C 85,200 70,180 78,157 Z"
                className={partClasses('Pelvis')}
                onClick={() => handleTogglePart('Pelvis')}
              />
              {/* Left Arm (Viewer Right) */}
              <path
                d="M 132,62 C 145,60 155,70 152,110 L 135,105 C 130,80 132,62 132,62 Z"
                className={partClasses('Left Arm (Front)')}
                onClick={() => handleTogglePart('Left Arm (Front)')}
              />
              <path
                d="M 136,108 L 152,113 C 150,140 155,160 145,160 L 135,160 C 132,140 136,108 136,108 Z"
                className={partClasses('Left Forearm (Front)')}
                onClick={() => handleTogglePart('Left Forearm (Front)')}
              />
              <path
                d="M 136,162 L 145,162 C 148,180 135,185 135,175 Z"
                className={partClasses('Left Hand (Front)')}
                onClick={() => handleTogglePart('Left Hand (Front)')}
              />
              {/* Right Arm (Viewer Left) */}
              <path
                d="M 68,62 C 55,60 45,70 48,110 L 65,105 C 70,80 68,62 68,62 Z"
                className={partClasses('Right Arm (Front)')}
                onClick={() => handleTogglePart('Right Arm (Front)')}
              />
              <path
                d="M 64,108 L 48,113 C 50,140 45,160 55,160 L 65,160 C 68,140 64,108 64,108 Z"
                className={partClasses('Right Forearm (Front)')}
                onClick={() => handleTogglePart('Right Forearm (Front)')}
              />
              <path
                d="M 64,162 L 55,162 C 52,180 65,185 65,175 Z"
                className={partClasses('Right Hand (Front)')}
                onClick={() => handleTogglePart('Right Hand (Front)')}
              />
              {/* Left Leg (Viewer Right) */}
              <path
                d="M 102,198 C 115,190 125,185 125,250 L 105,250 C 102,230 102,198 102,198 Z"
                className={partClasses('Left Thigh (Front)')}
                onClick={() => handleTogglePart('Left Thigh (Front)')}
              />
              <path
                d="M 105,252 L 124,252 C 124,280 115,310 110,320 L 102,320 C 102,290 105,252 105,252 Z"
                className={partClasses('Left Shin/Knee')}
                onClick={() => handleTogglePart('Left Shin/Knee')}
              />
              <path
                d="M 102,322 L 110,322 C 112,340 120,345 105,345 C 100,345 102,322 102,322 Z"
                className={partClasses('Left Foot')}
                onClick={() => handleTogglePart('Left Foot')}
              />
              {/* Right Leg (Viewer Left) */}
              <path
                d="M 98,198 C 85,190 75,185 75,250 L 95,250 C 98,230 98,198 98,198 Z"
                className={partClasses('Right Thigh (Front)')}
                onClick={() => handleTogglePart('Right Thigh (Front)')}
              />
              <path
                d="M 95,252 L 76,252 C 76,280 85,310 90,320 L 98,320 C 98,290 95,252 95,252 Z"
                className={partClasses('Right Shin/Knee')}
                onClick={() => handleTogglePart('Right Shin/Knee')}
              />
              <path
                d="M 98,322 L 90,322 C 88,340 80,345 95,345 C 100,345 98,322 98,322 Z"
                className={partClasses('Right Foot')}
                onClick={() => handleTogglePart('Right Foot')}
              />
            </svg>
          </div>

          {/* 背面 Back */}
          <div className="text-center">
            <span className="text-[11px] font-bold text-slate-700 block mb-2">{publicText('back', lang)}</span>
            <svg viewBox="0 0 200 370" className="w-36 sm:w-44 h-auto drop-shadow-xs">
              {/* Head & Neck Back */}
              <ellipse
                cx="100"
                cy="30"
                rx="16"
                ry="22"
                className={partClasses('Back of Head')}
                onClick={() => handleTogglePart('Back of Head')}
              />
              <path
                d="M 92,48 L 108,48 L 110,60 L 90,60 Z"
                className={partClasses('Back of Neck')}
                onClick={() => handleTogglePart('Back of Neck')}
              />
              {/* Torso Back */}
              <path
                d="M 70,60 L 130,60 C 145,70 145,100 130,105 L 70,105 C 55,100 55,70 70,60 Z"
                className={partClasses('Upper Back / Scapula')}
                onClick={() => handleTogglePart('Upper Back / Scapula')}
              />
              <path
                d="M 72,107 L 128,107 C 125,130 125,150 122,155 L 78,155 C 75,150 75,130 72,107 Z"
                className={partClasses('Lower Back / Lumbar')}
                onClick={() => handleTogglePart('Lower Back / Lumbar')}
              />
              <path
                d="M 78,157 L 122,157 C 130,180 115,200 100,200 C 85,200 70,180 78,157 Z"
                className={partClasses('Glutes')}
                onClick={() => handleTogglePart('Glutes')}
              />
              {/* Left Arm (Viewer Left on Back) */}
              <path
                d="M 68,62 C 55,60 45,70 48,110 L 65,105 C 70,80 68,62 68,62 Z"
                className={partClasses('Left Arm (Back)')}
                onClick={() => handleTogglePart('Left Arm (Back)')}
              />
              <path
                d="M 64,108 L 48,113 C 50,140 45,160 55,160 L 65,160 C 68,140 64,108 64,108 Z"
                className={partClasses('Left Forearm (Back)')}
                onClick={() => handleTogglePart('Left Forearm (Back)')}
              />
              <path
                d="M 64,162 L 55,162 C 52,180 65,185 65,175 Z"
                className={partClasses('Left Hand (Back)')}
                onClick={() => handleTogglePart('Left Hand (Back)')}
              />
              {/* Right Arm (Viewer Right on Back) */}
              <path
                d="M 132,62 C 145,60 155,70 152,110 L 135,105 C 130,80 132,62 132,62 Z"
                className={partClasses('Right Arm (Back)')}
                onClick={() => handleTogglePart('Right Arm (Back)')}
              />
              <path
                d="M 136,108 L 152,113 C 150,140 155,160 145,160 L 135,160 C 132,140 136,108 136,108 Z"
                className={partClasses('Right Forearm (Back)')}
                onClick={() => handleTogglePart('Right Forearm (Back)')}
              />
              <path
                d="M 136,162 L 145,162 C 148,180 135,185 135,175 Z"
                className={partClasses('Right Hand (Back)')}
                onClick={() => handleTogglePart('Right Hand (Back)')}
              />
              {/* Left Leg (Viewer Left on Back) */}
              <path
                d="M 98,198 C 85,190 75,185 75,250 L 95,250 C 98,230 98,198 98,198 Z"
                className={partClasses('Left Hamstring (Back)')}
                onClick={() => handleTogglePart('Left Hamstring (Back)')}
              />
              <path
                d="M 95,252 L 76,252 C 76,280 85,310 90,320 L 98,320 C 98,290 95,252 95,252 Z"
                className={partClasses('Left Calf (Back)')}
                onClick={() => handleTogglePart('Left Calf (Back)')}
              />
              <path
                d="M 98,322 L 90,322 C 88,340 80,345 95,345 C 100,345 98,322 98,322 Z"
                className={partClasses('Left Sole/Heel')}
                onClick={() => handleTogglePart('Left Sole/Heel')}
              />
              {/* Right Leg (Viewer Right on Back) */}
              <path
                d="M 102,198 C 115,190 125,185 125,250 L 105,250 C 102,230 102,198 102,198 Z"
                className={partClasses('Right Hamstring (Back)')}
                onClick={() => handleTogglePart('Right Hamstring (Back)')}
              />
              <path
                d="M 105,252 L 124,252 C 124,280 115,310 110,320 L 102,320 C 102,290 105,252 105,252 Z"
                className={partClasses('Right Calf (Back)')}
                onClick={() => handleTogglePart('Right Calf (Back)')}
              />
              <path
                d="M 102,322 L 110,322 C 112,340 120,345 105,345 C 100,345 102,322 102,322 Z"
                className={partClasses('Right Sole/Heel')}
                onClick={() => handleTogglePart('Right Sole/Heel')}
              />
            </svg>
          </div>
        </div>

        {/* 标注摘要看板 */}
        <div className="space-y-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-900 space-y-1.5">
            <span className="font-bold flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
              {publicText('focusAreas', lang)} ({value.focus.length}):
            </span>
            <div className="flex flex-wrap gap-1">
              {value.focus.length === 0 ? (
                <span className="text-slate-400 text-[11px]">{publicText('noMarks', lang)}</span>
              ) : (
                value.focus.map((p, idx) => (
                  <Badge key={idx} className="bg-emerald-600 text-white text-[10px] px-1.5 py-0.5">
                    {bodyPartText(p, lang)}
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-900 space-y-1.5">
            <span className="font-bold flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />
              {publicText('avoidAreas', lang)} ({value.avoid.length}):
            </span>
            <div className="flex flex-wrap gap-1">
              {value.avoid.length === 0 ? (
                <span className="text-slate-400 text-[11px]">{publicText('noMarks', lang)}</span>
              ) : (
                value.avoid.map((p, idx) => (
                  <Badge key={idx} variant="destructive" className="text-[10px] px-1.5 py-0.5">
                    🚫 {bodyPartText(p, lang)}
                  </Badge>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
