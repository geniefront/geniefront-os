import React, { useRef, useState, useEffect, useCallback } from 'react';
import { PenLine, RotateCcw, Check, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useLanguage } from '@/LanguageContext';
import { publicText } from '@/features/forms/publicCopy';

interface SignaturePadProps {
  onSave?: (dataUrl: string) => void;
  onClear?: () => void;
  width?: number;
  height?: number;
  activeLanguage?: string;
}

export function SignaturePad({
  onSave,
  onClear,
  width = 500,
  height = 180,
  activeLanguage,
}: SignaturePadProps) {
  const { language } = useLanguage();
  const lang = activeLanguage || language;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [strokeHistory, setStrokeHistory] = useState<ImageData[]>([]);

  // 初始化画布
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a'; // slate-900
    ctx.lineWidth = 2.5;

    // 清空背景
    ctx.clearRect(0, 0, width, height);
  }, [width, height]);

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
    } else {
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }
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
    <div className="rounded-2xl border border-slate-300 bg-white p-3 space-y-2 shadow-xs">
      <div className="flex items-center justify-between text-xs font-bold text-slate-800">
        <span className="flex items-center gap-1.5 text-teal-700">
          <PenLine className="h-4 w-4" />
          {publicText('signature', lang)} <span className="text-red-500">*</span>
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={strokeHistory.length === 0}
            onClick={handleUndo}
            className="h-7 text-[11px] text-slate-500"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {publicText('undo', lang)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasSignature}
            onClick={handleClear}
            className="h-7 text-[11px] text-slate-500 hover:text-red-600"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            {publicText('clear', lang)}
          </Button>
        </div>
      </div>

      {/* 手写区域 Canvas */}
      <div className="relative overflow-hidden rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 touch-none">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="cursor-crosshair w-full h-[140px] sm:h-[160px]"
        />

        {!hasSignature && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <PenLine className="h-4 w-4 text-teal-600/70" />
              {publicText('signHere', lang)}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
        <span>{publicText('signatureHint', lang)}</span>
        {hasSignature && (
          <span className="text-emerald-600 font-bold flex items-center gap-1">
            <Check className="h-3 w-3" />
            {publicText('signatureReady', lang)}
          </span>
        )}
      </div>
    </div>
  );
}
