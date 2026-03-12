import React, { useState, useEffect, useCallback } from 'react';
import { 
  Upload, 
  FileSpreadsheet, 
  Users, 
  Trash2, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Image as ImageIcon,
  ChevronRight,
  Download,
  X,
  Plus,
  Calendar,
  ArrowLeft,
  Shield,
  User,
  Save,
  Edit2,
  Lock,
  Search,
  Settings,
  Key
} from 'lucide-react';

declare global {
  interface Window {
    aistudio?: {
      openSelectKey?: () => Promise<void>;
      hasSelectedApiKey?: () => Promise<boolean>;
    };
  }
}
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { processAttendanceImages, IdentifiedPerson } from './services/geminiService';
import { exportToExcel, AttendanceRecord } from './services/excelService';

interface Session {
  id: string;
  title: string;
  date: string;
  description: string;
  category: string;
}

interface SessionDetail extends Session {
  records: AttendanceRecord[];
  images: { id: string, data: string, index: number }[];
}

interface UploadedFile {
  id: string;
  file: File;
  preview: string;
}

const FaceHighlight = ({ 
  src, 
  box, 
  className 
}: { 
  src: string; 
  box: [number, number, number, number]; 
  className?: string 
}) => {
  if (!src) return <div className={cn("bg-slate-200 animate-pulse rounded-lg", className)} />;

  const [ymin, xmin, ymax, xmax] = box;
  const boxWidth = xmax - xmin;
  const boxHeight = ymax - ymin;
  const centerX = xmin + boxWidth / 2;
  const centerY = ymin + boxHeight / 2;
  
  const zoom = 1000 / (Math.max(boxWidth, boxHeight, 40) * 1.2);
  const px = centerX / 1000;
  const py = centerY / 1000;
  const posX = zoom > 1 ? ((px * zoom - 0.5) / (zoom - 1)) * 100 : 50;
  const posY = zoom > 1 ? ((py * zoom - 0.5) / (zoom - 1)) * 100 : 50;
  
  return (
    <div className={cn("relative overflow-hidden rounded-xl border-2 border-slate-200 bg-slate-900 group cursor-zoom-in shadow-md transition-all hover:border-indigo-400", className)}>
      <div 
        className="absolute inset-0 w-full h-full transition-all duration-700 group-hover:scale-110"
        style={{
          backgroundImage: `url(${src})`,
          backgroundPosition: `${posX}% ${posY}%`,
          backgroundSize: `${zoom * 100}%`,
          backgroundRepeat: 'no-repeat',
          opacity: 0.95
        }}
      />
      <div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-yellow-400 rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_0_15px_rgba(255,255,0,0.8)] pointer-events-none z-10 animate-pulse"
        style={{ width: '60%', height: '60%' }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle,transparent_35%,rgba(0,0,0,0.4)_100%)] pointer-events-none" />
    </div>
  );
};

export default function App() {
  const [view, setView] = useState<'home' | 'session'>('home');
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem('is_admin') === 'true');
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionDetail | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<{src: string, box?: [number, number, number, number]} | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  
  const [newSessionData, setNewSessionData] = useState({ 
    title: '', 
    description: '', 
    category: '软件过程改进',
    date: new Date().toISOString().split('T')[0] 
  });
  
  const [editingSession, setEditingSession] = useState<Session | null>(null);

  const [activeTab, setActiveTab] = useState<'全部' | '软件过程改进' | '软件测试技术'>('全部');
  const [searchTerm, setSearchTerm] = useState('');
  const [userApiKey, setUserApiKey] = useState<string>(() => localStorage.getItem('user_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'session' | 'record', id: string, personId?: string } | null>(null);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [recordsPage, setRecordsPage] = useState(1);
  const SESSIONS_PER_PAGE = 12;
  const RECORDS_PER_PAGE = 50;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const handleOpenSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setError("已打开 API Key 选择对话框。选择后请重试识别。");
    } else {
      setIsSettingsOpen(true);
    }
  };

  const categories = ['全部', '软件过程改进', '软件测试技术'] as const;

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginData)
      });
      if (!res.ok) throw new Error("登录失败");
      const data = await res.json();
      if (data.success) {
        setIsAdmin(true);
        localStorage.setItem('is_admin', 'true');
        setIsLoginModalOpen(false);
        setLoginData({ username: '', password: '' });
      } else {
        setLoginError(data.error || '用户名或密码错误');
      }
    } catch (err: any) {
      setLoginError('网络连接失败');
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error("获取失败");
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      setError("获取课程列表失败");
    }
  };

  const fetchSessionDetail = async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error("获取详情失败");
      const data = await res.json();
      setCurrentSession(data);
      setSelectedIds([]);
      setView('session');
    } catch (err) {
      setError("获取课程详情失败");
    }
  };

  const handleCreateSession = async () => {
    if (!newSessionData.title) return;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSessionData)
      });
      const data = await res.json();
      setSessions(prev => [data, ...prev]);
      setIsCreatingSession(false);
      setNewSessionData({ title: '', description: '', category: '软件过程改进', date: new Date().toISOString().split('T')[0] });
      fetchSessionDetail(data.id);
    } catch (err) {}
  };

  const handleUpdateSession = async () => {
    if (!editingSession || !editingSession.title) return;
    try {
      const res = await fetch(`/api/sessions/${editingSession.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingSession)
      });
      if (!res.ok) throw new Error("更新失败");
      
      setSessions(prev => prev.map(s => s.id === editingSession.id ? editingSession : s));
      
      if (currentSession?.id === editingSession.id) {
        setCurrentSession(prev => prev ? { ...prev, ...editingSession } : null);
      }
      setEditingSession(null);
    } catch (err) {
      alert("更新课程信息失败");
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete({ type: 'session', id });
  };

  const confirmDeleteAction = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.type === 'session') {
        const res = await fetch(`/api/sessions/${confirmDelete.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error("删除失败");
        setSessions(prev => prev.filter(s => s.id !== confirmDelete.id));
        if (currentSession?.id === confirmDelete.id) {
          setView('home');
        }
      } else if (confirmDelete.type === 'record' && confirmDelete.personId) {
        const res = await fetch(`/api/sessions/${confirmDelete.id}/records/${confirmDelete.personId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error("删除失败");
        setCurrentSession(prev => prev ? { ...prev, records: prev.records.filter(r => r.personId !== confirmDelete.personId) } : null);
        setSelectedIds(prev => prev.filter(id => id !== confirmDelete.personId));
      }
      setConfirmDelete(null);
    } catch (err: any) {
      alert(err.message || "删除失败，由于数据库外键限制，请确保后端 server.ts 的删除接口已更新。");
      setConfirmDelete(null);
    }
  };

  const handleRecordUpdate = async (personId: string, updates: { name?: string, studentId?: string }) => {
    if (!currentSession) return;
    const record = currentSession.records.find(r => r.personId === personId);
    if (!record) return;
    const newName = updates.name !== undefined ? updates.name : record.name;
    const newStudentId = updates.studentId !== undefined ? updates.studentId : record.studentId;
    try {
      await fetch(`/api/sessions/${currentSession.id}/records/${personId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, studentId: newStudentId })
      });
      setCurrentSession(prev => prev ? { ...prev, records: prev.records.map(r => r.personId === personId ? { ...r, name: newName, studentId: newStudentId } : r) } : null);
    } catch (err) {}
  };

  const [isStudentSignInOpen, setIsStudentSignInOpen] = useState(false);
  const [studentSignInData, setStudentSignInData] = useState({ name: '', studentId: '', photo: '' });
  const [isSubmittingSignIn, setIsSubmittingSignIn] = useState(false);

  const handleStudentSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession || !studentSignInData.name || !studentSignInData.studentId) return;

    // 💡 新增：拦截校验，强制要求必须上传照片
    if (!studentSignInData.photo) {
      alert("请必须上传一张照片完成签到验证！");
      return;
    }

    setIsSubmittingSignIn(true);
    try {
      const res = await fetch(`/api/sessions/${currentSession.id}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: `S${Date.now()}`, description: "学生自主签到", name: studentSignInData.name, studentId: studentSignInData.studentId, photo: studentSignInData.photo })
      });
      const data = await res.json();
      setCurrentSession(prev => prev ? { ...prev, records: [...prev.records, { ...data, appearances: [] }] } : null);
      setIsStudentSignInOpen(false);
      setStudentSignInData({ name: '', studentId: '', photo: '' });
      alert("签到成功！");
    } catch (err) { alert("签到失败"); } 
    finally { setIsSubmittingSignIn(false); }
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => setStudentSignInData(prev => ({ ...prev, photo: event.target?.result as string }));
      reader.readAsDataURL(file);
    }
  };

  // 💡 修复：补回了缺失的手动补录/学生签到打开按钮事件
  const handleAddManualRecord = async () => {
    if (!currentSession) return;
    setIsStudentSignInOpen(true);
  };

  const handleBatchDelete = async () => {
    if (!currentSession || selectedIds.length === 0) return;
    if (!confirm(`确定要删除选中的 ${selectedIds.length} 条记录吗？`)) return;
    try {
      await fetch(`/api/sessions/${currentSession.id}/records/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personIds: selectedIds })
      });
      setCurrentSession(prev => prev ? { ...prev, records: prev.records.filter(r => !selectedIds.includes(r.personId)) } : null);
      setSelectedIds([]);
    } catch (err) { alert("批量删除失败"); }
  };

  const toggleSelect = (personId: string) => setSelectedIds(prev => prev.includes(personId) ? prev.filter(id => id !== personId) : [...prev, personId]);
  const toggleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!currentSession) return;
    if (e.target.checked) setSelectedIds(currentSession.records.map(r => r.personId));
    else setSelectedIds([]);
  };

  const handleAIProcess = async () => {
    if (!currentSession || files.length === 0) return;
    setIsProcessing(true);
    setError(null);
    const resizeImage = (file: File): Promise<string> => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width; let height = img.height; const maxSide = 1600;
            if (width > height) { if (width > maxSide) { height *= maxSide / width; width = maxSide; } } 
            else { if (height > maxSide) { width *= maxSide / height; height = maxSide; } }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d'); ctx?.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.85)); 
          };
          img.src = e.target?.result as string;
        };
        reader.readAsDataURL(file);
      });
    };

    try {
      const imagePromises = files.map(async (f, index) => {
        const resizedData = await resizeImage(f.file);
        return { data: resizedData, name: `图片${index + 1}`, index: index + 1 };
      });
      const imageData = await Promise.all(imagePromises);
      const identifiedPeople = await processAttendanceImages(imageData, userApiKey || undefined);
      
      const syncRes = await fetch(`/api/sessions/${currentSession.id}/sync`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: identifiedPeople, images: imageData.map(img => ({ data: img.data, index: img.index })) })
      });
      if (!syncRes.ok) throw new Error("同步失败");
      await fetchSessionDetail(currentSession.id);
      setFiles([]);
    } catch (err: any) { setError(err.message || "AI 处理失败"); } 
    finally { setIsProcessing(false); }
  };

  const getFilePreview = (appearance: any) => {
    const { imageIndex } = appearance;
    if (typeof imageIndex === 'number' && files[imageIndex - 1]) return files[imageIndex - 1].preview;
    if (currentSession?.images) {
      const persisted = currentSession.images.find(img => img.index === imageIndex);
      if (persisted) return persisted.data;
    }
    return '';
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).map((file: File) => ({ id: Math.random().toString(36).substring(7), file, preview: URL.createObjectURL(file) }));
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-slate-900 font-sans selection:bg-indigo-100">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => { setView('home'); setSelectedIds([]); }}>
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-indigo-200 shadow-lg">
              <Users className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight leading-none">智能课堂签到</h1>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-1">Attendance System</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-slate-50 rounded-full transition-colors"
              title="设置"
            >
              <Settings className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
            <button 
              onClick={() => { setIsAdmin(false); localStorage.removeItem('is_admin'); }}
              className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all", !isAdmin ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700")}
            >
              <User className="w-3.5 h-3.5" /> 学生端
            </button>
            <button 
              onClick={() => { if (isAdmin) { setIsAdmin(false); localStorage.removeItem('is_admin'); } else { setIsLoginModalOpen(true); } }}
              className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all", isAdmin ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700")}
            >
              <Shield className="w-3.5 h-3.5" /> {isAdmin ? '退出管理' : '管理员登录'}
            </button>
          </div>
        </div>
      </div>
    </header>

      <main className="max-w-6xl mx-auto px-4 py-8 relative z-10">
        <AnimatePresence mode="wait">
          {view === 'home' ? (
            <motion.div 
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-2 p-1 bg-slate-200/50 rounded-2xl w-fit">
                  {categories.map(cat => (
                    <button
                      key={cat}
                      onClick={() => setActiveTab(cat)}
                      className={cn("px-6 py-2.5 text-sm font-bold transition-all rounded-xl", activeTab === cat ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-white/50")}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                
                <div className="flex items-center gap-3">
                  {isAdmin && (
                    <button 
                      onClick={() => setIsCreatingSession(true)}
                      className="flex items-center gap-2 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold shadow-xl transition-all active:scale-95"
                    >
                      <Plus className="w-5 h-5" />
                      新建课程
                    </button>
                  )}
                </div>
              </div>

              {isCreatingSession && (
                <motion.div 
                  initial={{ opacity: 0, y: -10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-2xl shadow-slate-200/50 space-y-8 relative overflow-hidden"
                >
                  <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 blur-[100px] -mr-32 -mt-32 pointer-events-none" />
                  
                  <div className="flex items-center gap-4 relative z-10">
                    <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-100">
                      <Plus className="w-6 h-6 text-white" />
                    </div>
                    <div>
                      <h3 className="text-2xl font-black text-slate-800 tracking-tight">新建课程记录</h3>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 relative z-10">
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程名称</label>
                      <input 
                        type="text" 
                        placeholder="例如：3月9日 签到"
                        value={newSessionData.title}
                        onChange={e => setNewSessionData(prev => ({ ...prev, title: e.target.value }))}
                        className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300 shadow-sm"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程日期</label>
                      <input 
                        type="date" 
                        value={newSessionData.date}
                        onChange={e => setNewSessionData(prev => ({ ...prev, date: e.target.value }))}
                        className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold shadow-sm"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程分类</label>
                      <div className="relative">
                        <select 
                          value={newSessionData.category}
                          onChange={e => setNewSessionData(prev => ({ ...prev, category: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold appearance-none cursor-pointer shadow-sm"
                        >
                          {categories.filter(cat => cat !== '全部').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">备注描述</label>
                      <input 
                        type="text" 
                        placeholder="可选备注信息"
                        value={newSessionData.description}
                        onChange={e => setNewSessionData(prev => ({ ...prev, description: e.target.value }))}
                        className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300 shadow-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end items-center gap-6 relative z-10 pt-4 border-t border-slate-50">
                    <button onClick={() => setIsCreatingSession(false)} className="text-sm font-black text-slate-400 hover:text-slate-600 transition-colors">
                      取消操作
                    </button>
                    <button onClick={handleCreateSession} className="px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 transition-all active:scale-95 flex items-center gap-2">
                      <Save className="w-5 h-5" /> 确认创建
                    </button>
                  </div>
                </motion.div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {sessions.filter(s => activeTab === '全部' || s.category === activeTab).length === 0 ? (
                  <div className="col-span-full py-20 text-center text-slate-400">
                    <Calendar className="w-16 h-16 mx-auto mb-4 opacity-10" />
                    <p>该分类下暂无课程信息</p>
                  </div>
                ) : (
                  sessions
                    .filter(s => activeTab === '全部' || s.category === activeTab)
                    .slice(0, sessionsPage * SESSIONS_PER_PAGE)
                    .map(session => (
                      <motion.div 
                        key={session.id}
                        whileHover={{ y: -6, scale: 1.02 }}
                        onClick={() => fetchSessionDetail(session.id)}
                        className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all cursor-pointer group relative overflow-hidden flex flex-col justify-between"
                      >
                        <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity pointer-events-none">
                          <Calendar className="w-24 h-24" />
                        </div>
                        
                        <div>
                          <div className="flex items-start justify-between mb-4">
                            <span className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider w-fit", session.category === '软件过程改进' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700")}>
                              {session.category}
                            </span>
                            
                            {isAdmin && (
                              <div className="flex items-center gap-1">
                                <button 
                                  onClick={(e) => { e.stopPropagation(); setEditingSession(session); }}
                                  className="p-2 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all"
                                  title="修改课程"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button 
                                  onClick={(e) => handleDeleteSession(session.id, e)}
                                  className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                                  title="删除课程"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          <h3 className="font-black text-xl text-slate-800 mb-2 leading-tight group-hover:text-indigo-600 transition-colors">{session.title}</h3>
                          <div className="flex items-center gap-2 text-slate-400 mb-6">
                            <Calendar className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">{new Date(session.date).toLocaleDateString()}</span>
                          </div>
                        </div>

                        <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-indigo-600 text-xs font-black uppercase tracking-wider">
                            进入课程 <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                          </div>
                        </div>
                      </motion.div>
                    ))
                )}
              </div>

              {sessions.filter(s => activeTab === '全部' || s.category === activeTab).length > sessionsPage * SESSIONS_PER_PAGE && (
                <div className="flex justify-center pt-4">
                  <button onClick={() => setSessionsPage(prev => prev + 1)} className="px-8 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold text-slate-600 hover:text-indigo-600 hover:border-indigo-100 transition-all shadow-sm">
                    加载更多课程
                  </button>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div 
              key="session"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <button 
                  onClick={() => { setView('home'); setSelectedIds([]); }}
                  className="flex items-center gap-2 px-4 py-2 bg-white text-slate-600 hover:text-indigo-600 font-bold text-sm rounded-xl border border-slate-200 shadow-sm transition-all active:scale-95"
                >
                  <ArrowLeft className="w-4 h-4" />
                  返回看板
                </button>
                <div className="flex items-center gap-3">
                  {isAdmin && (
                    <button 
                      onClick={() => exportToExcel(currentSession?.records || [], `签到表_${currentSession?.title}.xlsx`)}
                      className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-black shadow-lg shadow-emerald-100 transition-all active:scale-95"
                    >
                      <FileSpreadsheet className="w-4 h-4" /> 导出 EXCEL
                    </button>
                  )}
                </div>
              </div>

              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden relative">
                <div className="absolute top-0 right-0 p-12 opacity-[0.03] pointer-events-none">
                  <Users className="w-64 h-64" />
                </div>

                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10 relative z-10">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider", currentSession?.category === '软件过程改进' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700")}>
                        {currentSession?.category}
                      </span>
                      <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {currentSession ? new Date(currentSession.date).toLocaleDateString() : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <h2 className="text-4xl font-black text-slate-800 tracking-tight leading-tight">{currentSession?.title}</h2>
                      {isAdmin && (
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => setEditingSession(currentSession)}
                            className="p-2 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all"
                            title="修改课程信息"
                          >
                            <Edit2 className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={(e) => handleDeleteSession(currentSession.id, e)}
                            className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                            title="删除课程"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="text-slate-500 font-medium max-w-2xl">{currentSession?.description || "暂无详细描述"}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="px-6 py-3 bg-indigo-50 rounded-2xl border border-indigo-100 text-center min-w-[120px]">
                      <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest block mb-1">已签到</span>
                      <span className="text-3xl font-black text-indigo-600 leading-none">{currentSession?.records.length}</span>
                    </div>
                  </div>
                </div>

                {isAdmin && (
                  <div className="mb-10 p-8 bg-white rounded-[2.5rem] border border-slate-200 shadow-xl shadow-slate-200/40 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 blur-[100px] -mr-32 -mt-32 pointer-events-none" />
                    
                    <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
                      <div className="space-y-1 text-center md:text-left">
                        <h3 className="text-2xl font-black text-slate-800 flex items-center justify-center md:justify-start gap-4">
                          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100">
                            <ImageIcon className="w-6 h-6 text-white" />
                          </div>
                          AI 智能识别系统
                        </h3>
                      </div>
                      <label className="cursor-pointer px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-black transition-all flex items-center gap-2 shadow-xl shadow-indigo-100 active:scale-95">
                        <Upload className="w-4 h-4" /> 选择照片
                        <input type="file" multiple accept="image/*" className="hidden" onChange={onFileChange} disabled={isProcessing} />
                      </label>
                    </div>

                    {files.length > 0 && (
                      <div className="mt-8 space-y-6 relative z-10">
                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                          {files.map((file, idx) => (
                            <motion.div key={file.id} className="relative aspect-square rounded-2xl overflow-hidden border-2 border-slate-100 group shadow-sm">
                              <img src={file.preview} className="w-full h-full object-cover transition-transform group-hover:scale-110" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <button onClick={() => setFiles(prev => prev.filter(f => f.id !== file.id))} className="p-2 bg-red-500 text-white rounded-xl hover:bg-red-600"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            </motion.div>
                          ))}
                        </div>
                        <button onClick={handleAIProcess} disabled={isProcessing} className={cn("w-full py-4 rounded-2xl font-black flex items-center justify-center gap-3 transition-all shadow-xl", isProcessing ? "bg-slate-100 text-slate-400" : "bg-slate-900 hover:bg-slate-800 text-white active:scale-[0.99]")}>
                          {isProcessing ? <><Loader2 className="w-6 h-6 animate-spin" /> 正在识别...</> : <><CheckCircle2 className="w-6 h-6" /> 开始AI识别</>}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-6 relative z-10">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-8 bg-indigo-600 rounded-full" />
                      <h3 className="text-2xl font-black text-slate-800 tracking-tight">签到名单</h3>
                    </div>
                    
                    <div className="flex flex-1 max-w-md items-center gap-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input type="text" placeholder="搜索..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full pl-11 pr-4 py-2.5 bg-slate-50 border border-slate-100 rounded-xl focus:ring-4 focus:ring-indigo-500 outline-none text-sm font-medium" />
                      </div>
                      {isAdmin && selectedIds.length > 0 && (
                        <button onClick={handleBatchDelete} className="px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white text-xs font-black rounded-xl flex items-center gap-2"><Trash2 className="w-4 h-4" /> 删除({selectedIds.length})</button>
                      )}
                      {!isAdmin && <button onClick={() => setIsStudentSignInOpen(true)} className="px-4 py-2.5 bg-indigo-600 text-white text-xs font-black rounded-xl flex items-center gap-2"><Plus className="w-4 h-4" /> 学生签到</button>}
                      {isAdmin && <button onClick={handleAddManualRecord} className="px-4 py-2.5 bg-slate-100 text-slate-600 text-xs font-black rounded-xl flex items-center gap-2"><Plus className="w-4 h-4" /> 手动补录</button>}
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-[2rem] border border-slate-100 bg-slate-50/30">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/80 backdrop-blur-md border-b border-slate-100">
                          {isAdmin && (
                            <th className="px-6 py-5 w-12 text-center">
                              <input type="checkbox" checked={currentSession?.records.length !== undefined && currentSession.records.length > 0 && selectedIds.length === currentSession.records.length} onChange={toggleSelectAll} className="w-4 h-4 rounded text-indigo-600 cursor-pointer"/>
                            </th>
                          )}
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">人员标识</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">姓名</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">学号</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">特征描述</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">识别特写</th>
                          {isAdmin && <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">操作</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {currentSession?.records.filter(record => record.description.toLowerCase().includes(searchTerm.toLowerCase()) || record.name.toLowerCase().includes(searchTerm.toLowerCase()) || (record.studentId || '').toLowerCase().includes(searchTerm.toLowerCase())).slice(0, recordsPage * RECORDS_PER_PAGE).map(record => (
                            <tr key={record.personId} className={cn("hover:bg-white transition-all group", selectedIds.includes(record.personId) && "bg-indigo-50/50 hover:bg-indigo-50/80")}>
                            {isAdmin && <td className="px-6 py-6 text-center"><input type="checkbox" checked={selectedIds.includes(record.personId)} onChange={() => toggleSelect(record.personId)} className="w-4 h-4 rounded text-indigo-600 cursor-pointer"/></td>}
                            <td className="px-8 py-6"><span className="text-xs font-black font-mono text-slate-300 bg-slate-100 px-2 py-1 rounded-lg">{record.personId}</span></td>
                            <td className="px-8 py-6">
                              <div className="flex items-center gap-2">
                                <input type="text" placeholder="姓名" value={record.name} onChange={(e) => handleRecordUpdate(record.personId, { name: e.target.value })} className="bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-indigo-500 focus:outline-none py-1 text-base font-black text-slate-700 w-24"/>
                                <Edit2 className="w-3 h-3 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </div>
                            </td>
                            <td className="px-8 py-6"><input type="text" placeholder="学号" value={record.studentId || ''} onChange={(e) => handleRecordUpdate(record.personId, { studentId: e.target.value })} className="bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-indigo-500 focus:outline-none py-1 text-sm font-bold text-slate-600 w-28"/></td>
                            <td className="px-8 py-6"><p className="text-sm text-slate-500 font-medium leading-relaxed max-w-xs">{record.description}</p></td>
                            <td className="px-8 py-6">
                              <div className="flex flex-wrap gap-3">
                                {record.appearances.map((app, i) => (<motion.button whileHover={{ scale: 1.1, rotate: 2 }} key={i} onClick={() => setSelectedImage({ src: getFilePreview(app), box: app.box_2d })} className="relative"><FaceHighlight src={getFilePreview(app)} box={app.box_2d} className="w-14 h-14 rounded-2xl" /></motion.button>))}
                                {record.photo && <motion.button whileHover={{ scale: 1.1, rotate: 2 }} onClick={() => setSelectedImage({ src: record.photo! })} className="relative"><img src={record.photo} className="w-14 h-14 rounded-2xl object-cover border-2 border-indigo-200" /></motion.button>}
                              </div>
                            </td>
                            {isAdmin && <td className="px-8 py-6 text-right"><button onClick={() => handleDeleteRecord(record.personId)} className="p-3 text-slate-300 hover:text-red-500 rounded-2xl"><Trash2 className="w-5 h-5" /></button></td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* 💡 修改课程信息的弹出 Modal */}
      <AnimatePresence>
        {editingSession && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md"
            onClick={() => setEditingSession(null)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="bg-white max-w-md w-full rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center mb-8">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-100 mb-4">
                  <Edit2 className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-2xl font-black text-slate-800 tracking-tight">修改课程信息</h3>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程名称</label>
                  <input 
                    type="text" 
                    value={editingSession.title}
                    onChange={e => setEditingSession(prev => prev ? ({ ...prev, title: e.target.value }) : null)}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500 focus:outline-none font-bold"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程日期</label>
                  <input 
                    type="date" 
                    value={editingSession.date.split('T')[0]} 
                    onChange={e => setEditingSession(prev => prev ? ({ ...prev, date: e.target.value }) : null)}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500 focus:outline-none font-bold"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程分类</label>
                  <select 
                    value={editingSession.category}
                    onChange={e => setEditingSession(prev => prev ? ({ ...prev, category: e.target.value }) : null)}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500 outline-none font-bold cursor-pointer"
                  >
                    {categories.filter(cat => cat !== '全部').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                  </select>
                </div>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setEditingSession(null)} className="flex-1 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-black">
                    取消
                  </button>
                  <button onClick={handleUpdateSession} className="flex-1 px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-xl shadow-indigo-100">
                    保存修改
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 💡 学生签到/手动补录的弹出 Modal */}
      <AnimatePresence>
        {isStudentSignInOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md"
            onClick={() => setIsStudentSignInOpen(false)}
          >
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }} className="bg-white max-w-md w-full rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex flex-col items-center text-center mb-8">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-100 mb-4">
                  <User className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-2xl font-black text-slate-800 tracking-tight">{isAdmin ? '手动补录' : '学生自主签到'}</h3>
                <p className="text-sm text-slate-400 font-medium mt-1">请填写信息并上传面部照片</p>
              </div>

              <form onSubmit={handleStudentSignIn} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">姓名</label>
                  <input type="text" required value={studentSignInData.name} onChange={e => setStudentSignInData(prev => ({ ...prev, name: e.target.value }))} className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold" placeholder="请输入姓名" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">学号</label>
                  <input type="text" required value={studentSignInData.studentId} onChange={e => setStudentSignInData(prev => ({ ...prev, studentId: e.target.value }))} className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold" placeholder="请输入学号" />
                </div>
                
                {/* 💡 新增恢复的照片上传区域，并设为必填效果 */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">个人照片 (必填)</label>
                  <div className="flex items-center gap-4">
                    <label className="flex-1 cursor-pointer px-6 py-4 bg-slate-50 border border-dashed border-slate-200 rounded-2xl hover:bg-slate-100 transition-all flex flex-col items-center justify-center gap-2">
                      {studentSignInData.photo ? (
                        <img src={studentSignInData.photo} className="w-16 h-16 rounded-xl object-cover" />
                      ) : (
                        <>
                          <ImageIcon className="w-6 h-6 text-slate-300" />
                          <span className="text-xs text-slate-400 font-bold">点击上传照片</span>
                        </>
                      )}
                      <input type="file" accept="image/*" className="hidden" onChange={handlePhotoUpload} />
                    </label>
                    {studentSignInData.photo && (
                      <button 
                        type="button"
                        onClick={() => setStudentSignInData(prev => ({ ...prev, photo: '' }))}
                        className="p-3 bg-red-50 text-red-500 rounded-2xl hover:bg-red-100 transition-colors"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex gap-4 pt-2">
                  <button type="button" onClick={() => setIsStudentSignInOpen(false)} className="flex-1 px-6 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black">取消</button>
                  <button type="submit" disabled={isSubmittingSignIn} className="flex-1 px-6 py-4 bg-indigo-600 text-white rounded-2xl font-black disabled:opacity-50">
                    {isSubmittingSignIn ? '提交中...' : '确认签到'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmDelete && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md" onClick={() => setConfirmDelete(null)}>
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }} className="bg-white max-w-sm w-full rounded-[2.5rem] p-10 shadow-2xl text-center" onClick={e => e.stopPropagation()}>
              <h3 className="text-2xl font-black text-slate-800 mb-2">确认删除？</h3>
              <div className="flex gap-4 mt-8">
                <button onClick={() => setConfirmDelete(null)} className="flex-1 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-black">取消</button>
                <button onClick={confirmDeleteAction} className="flex-1 px-6 py-4 bg-red-500 hover:bg-red-600 text-white rounded-2xl font-black shadow-xl shadow-red-100">确认删除</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}