import React, { useRef, useState, useEffect, useCallback } from 'react';
import { PenLine, Trash2, Check, RotateCcw } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

interface SignaturePadProps {
  onSave?: (dataUrl: string) => void;
  onClear?: () => void;
  required?: boolean;
}

export const SignaturePad: React.FC<SignaturePadProps> = ({
  onSave,
  onClear,
  required = true,
}) => {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [strokeHistory, setStrokeHistory] = useState<ImageData[]>([]);

  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = container.clientWidth || 500;
    const height = 180;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a'; // slate-900 smooth black ink
    ctx.lineWidth = 3;

    ctx.clearRect(0, 0, width, height);
  }, []);

  useEffect(() => {
    initCanvas();
  }, [initCanvas]);

  const saveStroke = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setStrokeHistory((prev) => [...prev, imageData]);
  };

  const getCoordinates = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    if ('touches' in e) {
      const touch = e.touches[0];
      if (!touch) return { x: 0, y: 0 };
      return {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const startDrawing = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    saveStroke();
    setIsDrawing(true);
    setHasSignature(true);

    const { x, y } = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ) => {
    if (!isDrawing) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCoordinates(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas && onSave) {
      const dataUrl = canvas.toDataURL('image/png');
      onSave(dataUrl);
    }
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    setStrokeHistory([]);
    if (onClear) onClear();
  };

  const handleUndo = () => {
    if (strokeHistory.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const newHistory = [...strokeHistory];
    const lastState = newHistory.pop();
    setStrokeHistory(newHistory);

    if (lastState) {
      ctx.putImageData(lastState, 0, 0);
      if (newHistory.length === 0) {
        setHasSignature(false);
      }
      if (onSave) {
        onSave(canvas.toDataURL('image/png'));
      }
    }
  };

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 space-y-3 shadow-sm select-none">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-base font-bold text-slate-900">
          <PenLine className="h-5 w-5 text-teal-600" />
          <span>{t('health.signature')}</span>
          {required && <span className="text-rose-500 text-sm">*</span>}
        </span>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={strokeHistory.length === 0}
            onClick={handleUndo}
            className="kiosk-touch-target px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-xs font-semibold text-slate-600 flex items-center gap-1.5 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Undo</span>
          </button>
          <button
            type="button"
            disabled={!hasSignature}
            onClick={handleClear}
            className="kiosk-touch-target px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-rose-50 disabled:opacity-40 text-xs font-semibold text-slate-600 hover:text-rose-600 flex items-center gap-1.5 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t('common.clear')}</span>
          </button>
        </div>
      </div>

      {/* 手写 Canvas 区域 */}
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/50 touch-none shadow-inner"
      >
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="cursor-crosshair w-full h-[160px] sm:h-[180px]"
        />

        {!hasSignature && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-400 font-medium">
            <span className="flex items-center gap-2">
              <PenLine className="h-5 w-5 text-teal-600/70" />
              <span>{t('health.signatureRequired')}</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
        <span>{t('health.signatureNotice')}</span>
        {hasSignature && (
          <span className="text-emerald-600 font-bold flex items-center gap-1 shrink-0">
            <Check className="h-4 w-4" />
            <span>Signed</span>
          </span>
        )}
      </div>
    </div>
  );
};
