/**
 * 表单校验的落点。
 *
 * 校验失败此前一律只弹 toast。toast 的问题有三个，且在长表单里同时发作：
 * 它几秒后消失、它不指明是哪一格、它对读屏用户等同于一段与表单无关的播报。
 * 设置页的项目编辑有十几个字段，用户读完「名称不能为空」还得自己去找是哪个
 * 名称 —— 而门店 iPad 上多数字段并不在当前视口里。
 *
 * 正确的落点是字段本身：标红、`aria-invalid`、错误文案就在输入框下方，并把
 * 焦点与视口移到第一个出错的字段上。toast 保留作为补充 —— 字段可能位于折叠
 * 面板或另一个标签页内，那时只有 toast 能让用户知道发生了什么。
 *
 * 用法：
 *
 * ```tsx
 * const form = useFieldErrors<'name' | 'phone'>();
 *
 * const submit = async () => {
 *   form.clear();
 *   if (!name.trim()) return form.fail('name', t('nameRequired'));
 *   if (!phone.trim()) return form.fail('phone', t('phoneRequired'));
 *   await save();
 * };
 *
 * <Input {...form.bind('name')} value={name} onChange={…} />
 * ```
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from './toast';

/** 可聚焦的表单控件。`bind` 的 ref 会接住 input / select / textarea。 */
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;

export interface FieldErrors<K extends string> {
  /** 当前各字段的错误文案。 */
  errors: Partial<Record<K, string>>;
  /**
   * 记下某字段的错误、把焦点与视口移过去、同时弹一条 toast。
   *
   * 返回 `false`，因此校验分支可以写成 `if (…) return form.fail(…)` —— 既
   * 表达了「这次提交到此为止」，又不必在每个分支后另起一行 `return`。
   */
  fail: (field: K, message: string) => false;
  /** 清掉某字段的错误。字段被修改时调用，让红框随着用户的修正消失。 */
  clearField: (field: K) => void;
  /** 清空全部错误。每次提交开始时调用。 */
  clear: () => void;
  /** 绑到输入控件上：错误态、`aria-invalid` 与用于聚焦的 ref。 */
  bind: (field: K) => {
    ref: (element: FormControl) => void;
    error: string | undefined;
    onBlur?: undefined;
  };
}

export function useFieldErrors<K extends string = string>(): FieldErrors<K> {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});
  const controls = useRef<Partial<Record<K, FormControl>>>({});

  const fail = useCallback((field: K, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }));
    /*
     * 聚焦放到下一帧。此刻 `setErrors` 还没渲染下去，若字段位于刚展开的面板
     * 或条件渲染的分支里，元素可能尚未挂载；等一帧再取 ref 才拿得到。
     */
    requestAnimationFrame(() => {
      const element = controls.current[field];

      /*
       * toast 只在字段看不见时补位。
       *
       * 字段就在眼前时，红框 + 下方错误文案已经把话说完了，再弹一条内容完全
       * 相同的 toast 只是把同一句话说两遍 —— 登录页两个输入框全在视口里，
       * 顶部还飘一条「请填写邮箱和密码」，属于噪音。
       *
       * 但字段在折叠面板里、在另一个标签页里、或在滚动区域之外时，红框对用户
       * 不可见，此时必须有 toast 说明「提交没有发生，以及为什么」—— 否则用户
       * 只会看到按下保存却什么都没发生。
       */
      if (!element) {
        toast.danger(message);
        return;
      }

      const rect = element.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || 0) &&
        rect.left < (window.innerWidth || 0);
      if (!visible) toast.danger(message);

      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return false as const;
  }, []);

  const clearField = useCallback((field: K) => {
    setErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const clear = useCallback(() => setErrors({}), []);

  const bind = useCallback(
    (field: K) => ({
      ref: (element: FormControl) => { controls.current[field] = element; },
      error: errors[field],
    }),
    [errors],
  );

  return { errors, fail, clearField, clear, bind };
}
