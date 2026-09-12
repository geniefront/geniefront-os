import React, { useState, useRef, useEffect } from 'react';
import { UploadCloud, Image as ImageIcon, Trash2, RefreshCw, Link as LinkIcon, Check, Eye } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { uploadImageToStorage, type ImageProcessOptions } from '@/lib/imageUpload';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { toast } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';

export interface ImageUploaderProps {
  value?: string;
  onChange: (url: string) => void;
  label?: string;
  description?: string;
  bucket?: 'avatars' | 'store_logos';
  aspectRatio?: 'square' | 'round' | 'wide';
  maxWidth?: number;
  maxHeight?: number;
  className?: string;
}

export function ImageUploader({
  value,
  onChange,
  label,
  description,
  bucket = 'avatars',
  aspectRatio = 'square',
  maxWidth = 512,
  maxHeight = 512,
  className = '',
}: ImageUploaderProps) {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 处理文件上传
  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.danger(t('settings.uploadInvalidType'));
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      toast.danger(t('settings.uploadTooLarge'));
      return;
    }

    setIsProcessing(true);
    try {
      const options: ImageProcessOptions = {
        maxWidth,
        maxHeight,
        quality: 0.88,
      };
      const resultUrl = await uploadImageToStorage(file, bucket, options);
      onChange(resultUrl);
      toast.success(t('settings.uploadSucceeded'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setIsProcessing(false);
    }
  };

  // 文件选择器变化
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
    // 重置 input 防止同名文件不触发
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // 拖拽事件处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  // 支持从剪贴板粘贴截图 (Cmd+V / Ctrl+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            void handleFile(file);
            break;
          }
        }
      }
    };

    const dropEl = dropZoneRef.current;
    if (dropEl) {
      dropEl.addEventListener('paste', handlePaste);
      return () => dropEl.removeEventListener('paste', handlePaste);
    }
  }, []);

  /** 图片 URL 输入的字段级校验。 */
  const urlForm = useFieldErrors<'url'>();

  const handleApplyUrl = () => {
    urlForm.clear();
    if (!urlDraft.trim()) {
      urlForm.fail('url', t('settings.uploadUrlRequired'));
      return;
    }
    onChange(urlDraft.trim());
    setShowUrlInput(false);
    setUrlDraft('');
    toast.success(t('settings.uploadUrlApplied'));
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {label && (
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-slate-800">{label}</label>
          {description && <span className="text-[11px] text-slate-400">{description}</span>}
        </div>
      )}

      {/* 隐藏的真实文件输入框 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* 已有图片时的预览视图 */}
      {value ? (
        <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-2xl">
          <div className="relative group shrink-0">
            <img
              src={value}
              alt="Uploaded Preview"
              className={`object-cover border-2 border-white shadow-sm bg-white ${
                aspectRatio === 'round'
                  ? 'w-16 h-16 rounded-full'
                  : aspectRatio === 'wide'
                  ? 'w-24 h-16 rounded-xl'
                  : 'w-16 h-16 rounded-2xl'
              }`}
              onError={() => toast.danger(t('settings.uploadPreviewFailed'))}
            />
            {isProcessing && (
              <div className="absolute inset-0 bg-black/40 rounded-2xl flex items-center justify-center text-white">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-xs font-bold text-slate-800 truncate">{t('settings.uploadSelected')}</p>
            <p className="text-[11px] text-slate-400 font-mono truncate">
              {value.startsWith('data:') ? t('settings.uploadLocalOptimized') : value}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing}
                className="text-xs font-bold text-teal-700 hover:text-teal-800 flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t('settings.uploadReplace')}</span>
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => onChange('')}
                disabled={isProcessing}
                className="text-xs font-bold text-rose-600 hover:text-rose-700 flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                <span>{t('settings.uploadRemove')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* 未上传图片时的上传交互区 */
        <div className="space-y-2">
          <div
            ref={dropZoneRef}
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`p-4 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-teal-500 bg-teal-50/70 scale-[1.01]'
                : 'border-slate-300 hover:border-teal-400 bg-slate-50/60 hover:bg-slate-50'
            }`}
          >
            <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center mb-2 shadow-2xs">
              {isProcessing ? (
                <RefreshCw className="w-5 h-5 animate-spin text-teal-600" />
              ) : (
                <UploadCloud className="w-5 h-5" />
              )}
            </div>

            <p className="text-xs font-bold text-slate-800">
              {isProcessing ? t('settings.uploadProcessing') : t('settings.uploadDropzone')}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">
              
              {t('settings.uploadFormatHint')}
            </p>
          </div>

          {/* 网络 URL 输入折叠器 */}
          <div>
            {!showUrlInput ? (
              <button
                type="button"
                onClick={() => setShowUrlInput(true)}
                className="text-[11px] text-slate-500 hover:text-teal-700 font-medium flex items-center gap-1 cursor-pointer transition-colors"
              >
                <LinkIcon className="w-3 h-3" />
                <span>{t('settings.uploadUrlOr')}</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 p-2 bg-slate-50 border border-slate-200 rounded-xl animate-fadeIn">
                <Input
                  {...urlForm.bind('url')}
                  value={urlDraft}
                  onChange={(e) => { setUrlDraft(e.target.value); urlForm.clearField('url'); }}
                  placeholder={t('settings.uploadUrlPlaceholder')}
                  className="text-xs flex-1 bg-white"
                  autoFocus
                />
                <Button size="sm" onClick={handleApplyUrl} className="bg-teal-600 hover:bg-teal-700 text-white text-xs px-3">
                  <Check className="w-3.5 h-3.5 mr-1" />
                  
                  {t('settings.uploadApply')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowUrlInput(false)} className="text-xs text-slate-500">
                  
                  {t('settings.uploadCancel')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
