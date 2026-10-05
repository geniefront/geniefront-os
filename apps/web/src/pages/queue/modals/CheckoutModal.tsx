/** Queue checkout embeds the same workbench as the standalone route. */
import {useState} from 'react';
import {CreditCard} from 'lucide-react';
import {Modal} from '@/components/ui/Modal';
import {useLanguage} from '@/LanguageContext';
import {CheckoutWorkbench} from '@/pages/Checkout';
import type {CloseResult} from '@/features/checkout/types';
export interface CheckoutModalProps {
  isOpen:boolean;
  ticketId:string|null;
  onOpenChange:(open:boolean)=>void;
  onSettled:(result:CloseResult)=>void|Promise<void>;
}
export function CheckoutModal({isOpen,ticketId,onOpenChange,onSettled}:CheckoutModalProps){
  const {t}=useLanguage();
  const [pending,setPending]=useState(false);
  if(!isOpen||!ticketId)return null;
  return <Modal isOpen onOpenChange={onOpenChange} isDismissDisabled={pending} size="cover"
    title={<div className="flex items-center gap-2"><CreditCard className="h-5 w-5"/>{t('queue.quCoTitle')}</div>}>
    <CheckoutWorkbench key={ticketId} ticketId={ticketId} embedded onSettled={onSettled} onPendingChange={setPending}/>
  </Modal>;
}
