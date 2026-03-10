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
  const [newSessionData, setNewSessionData] = useState({ title: '', description: '', category: '软件过程改进' });
  const [activeTab, setActiveTab] = useState<'全部' | '软件过程改进' | '软件测试技术'>('全部');
  const [searchTerm, setSearchTerm] = useState('');
  const [userApiKey, setUserApiKey] = useState<string>(() => localStorage.getItem('user_gemini_api_key') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'session' | 'record', id: string, personId?: string } | null>(null);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [recordsPage, setRecordsPage] = useState(1);
  const SESSIONS_PER_PAGE = 12;
  const RECORDS_PER_PAGE = 50;

  // 平台 API Key 选择逻辑
  const handleOpenSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      // 提示用户刷新或自动处理
      setError("已打开 API Key 选择对话框。选择后请重试识别。");
    } else {
      setIsSettingsOpen(true);
    }
  };

  const saveApiKey = (key: string) => {
    setUserApiKey(key);
    localStorage.setItem('user_gemini_api_key', key);
    setIsSettingsOpen(false);
  };

  const categories = ['全部', '软件过程改进', '软件测试技术'] as const;

  // Fetch sessions on mount
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
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `登录失败 (状态码: ${res.status})`);
      }
      
      const data = await res.json();
      if (data.success) {
        setIsAdmin(true);
        localStorage.setItem('is_admin', 'true');
        setIsLoginModalOpen(false);
        setLoginData({ username: '', password: '' });
        setLoginError(null);
      } else {
        setLoginError(data.error || '用户名或密码错误');
      }
    } catch (err: any) {
      console.error("Login failed", err);
      setLoginError(err.message === 'Failed to fetch' ? '网络连接失败，请检查后端服务是否运行' : (err.message || '登录请求失败，请稍后重试'));
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `获取课程列表失败 (状态码: ${res.status})`);
      }
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error("Failed to fetch sessions", err);
      const msg = err.message === 'Failed to fetch' ? '无法连接到服务器，请检查网络或刷新页面' : err.message;
      setError(msg || "获取课程列表失败");
    }
  };

  const fetchSessionDetail = async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error("获取课程详情失败");
      const data = await res.json();
      setCurrentSession(data);
      setView('session');
    } catch (err: any) {
      console.error("Failed to fetch session detail", err);
      setError(err.message || "获取课程详情失败");
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
      setNewSessionData({ title: '', description: '', category: '软件过程改进' });
      fetchSessionDetail(data.id);
    } catch (err) {
      console.error("Failed to create session", err);
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
      } else if (confirmDelete.type === 'record' && confirmDelete.personId) {
        const res = await fetch(`/api/sessions/${confirmDelete.id}/records/${confirmDelete.personId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error("删除失败");
        setCurrentSession(prev => {
          if (!prev) return null;
          return {
            ...prev,
            records: prev.records.filter(r => r.personId !== confirmDelete.personId)
          };
        });
      }
      setConfirmDelete(null);
    } catch (err: any) {
      setError(err.message || "删除失败");
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
      setCurrentSession(prev => {
        if (!prev) return null;
        return {
          ...prev,
          records: prev.records.map(r => r.personId === personId ? { ...r, name: newName, studentId: newStudentId } : r)
        };
      });
    } catch (err) {
      console.error("Failed to update record", err);
    }
  };

  const [isStudentSignInOpen, setIsStudentSignInOpen] = useState(false);
  const [studentSignInData, setStudentSignInData] = useState({ name: '', studentId: '', photo: '' });
  const [isSubmittingSignIn, setIsSubmittingSignIn] = useState(false);

  const handleStudentSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession || !studentSignInData.name || !studentSignInData.studentId) return;
    
    setIsSubmittingSignIn(true);
    try {
      const res = await fetch(`/api/sessions/${currentSession.id}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          personId: `S${Date.now()}`, 
          description: "学生自主签到", 
          name: studentSignInData.name, 
          studentId: studentSignInData.studentId,
          photo: studentSignInData.photo
        })
      });
      
      if (!res.ok) throw new Error("签到失败");
      
      const data = await res.json();
      setCurrentSession(prev => {
        if (!prev) return null;
        return {
          ...prev,
          records: [...prev.records, { ...data, appearances: [] }]
        };
      });
      setIsStudentSignInOpen(false);
      setStudentSignInData({ name: '', studentId: '', photo: '' });
      alert("签到成功！");
    } catch (err: any) {
      alert(err.message || "签到失败");
    } finally {
      setIsSubmittingSignIn(false);
    }
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setStudentSignInData(prev => ({ ...prev, photo: event.target?.result as string }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAddManualRecord = async () => {
    if (!currentSession) return;
    setIsStudentSignInOpen(true); // Reuse the same modal for manual add if admin
  };

  const handleDeleteRecord = async (personId: string) => {
    if (!currentSession) return;
    setConfirmDelete({ type: 'record', id: currentSession.id, personId });
  };

  const handleAIProcess = async () => {
    if (!currentSession || files.length === 0) return;
    setIsProcessing(true);
    setError(null);
    
    // 内部函数：压缩图片以提高识别成功率并减少 Payload 大小
    const resizeImage = (file: File): Promise<string> => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            const maxSide = 1600; // 1600px 足够人脸识别且能大幅减少数据量
            
            if (width > height) {
              if (width > maxSide) {
                height *= maxSide / width;
                width = maxSide;
              }
            } else {
              if (height > maxSide) {
                width *= maxSide / height;
                height = maxSide;
              }
            }
            
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.85)); // 使用 JPEG 压缩
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
      
      // Sync to backend including images
      const syncRes = await fetch(`/api/sessions/${currentSession.id}/sync`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          records: identifiedPeople,
          images: imageData.map(img => ({ data: img.data, index: img.index }))
        })
      });

      if (!syncRes.ok) {
        const errorData = await syncRes.json().catch(() => ({}));
        throw new Error(errorData.error || `同步识别结果到服务器失败 (状态码: ${syncRes.status})`);
      }

      // Refresh detail
      await fetchSessionDetail(currentSession.id);
      setFiles([]);
    } catch (err: any) {
      setError(err.message || "AI 处理失败");
    } finally {
      setIsProcessing(false);
    }
  };

  const getFilePreview = (appearance: any) => {
    const { imageIndex } = appearance;
    
    // 1. Try local files first (during active upload session)
    if (typeof imageIndex === 'number' && files[imageIndex - 1]) {
      return files[imageIndex - 1].preview;
    }
    
    // 2. Try persisted images from currentSession
    if (currentSession?.images) {
      const persisted = currentSession.images.find(img => img.index === imageIndex);
      if (persisted) return persisted.data;
    }
    
    return '';
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).map((file: File) => ({
        id: Math.random().toString(36).substring(7),
        file,
        preview: URL.createObjectURL(file)
      }));
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-slate-900 font-sans selection:bg-indigo-100">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('home')}>
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
              title="设置 API Key"
            >
              <Settings className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
            <button 
              onClick={() => {
                setIsAdmin(false);
                localStorage.removeItem('is_admin');
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                !isAdmin ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              <User className="w-3.5 h-3.5" />
              学生端
            </button>
            <button 
              onClick={() => {
                if (isAdmin) {
                  setIsAdmin(false);
                  localStorage.removeItem('is_admin');
                } else {
                  setIsLoginModalOpen(true);
                }
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                isAdmin ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              <Shield className="w-3.5 h-3.5" />
              {isAdmin ? '退出管理' : '管理员登录'}
            </button>
          </div>
        </div>
      </div>
    </header>

      <main className="max-w-6xl mx-auto px-4 py-8 relative z-10">
        {/* Global Schedule Banner */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-10 p-5 bg-gradient-to-r from-indigo-600 to-violet-600 rounded-[2rem] shadow-2xl shadow-indigo-200 flex items-center justify-between text-white relative overflow-hidden"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.1),transparent)] pointer-events-none" />
          <div className="flex items-center gap-4 relative z-10">
            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-xl border border-white/30">
              <Calendar className="w-6 h-6 text-white" />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-70">课程安排看板</p>
              <p className="text-base font-black">软件过程改进 (周一) &nbsp;•&nbsp; 软件测试技术 (周二)</p>
            </div>
          </div>
        </motion.div>

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
                      className={cn(
                        "px-6 py-2.5 text-sm font-bold transition-all rounded-xl",
                        activeTab === cat 
                          ? "bg-white text-indigo-600 shadow-sm" 
                          : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
                      )}
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
                      <p className="text-sm text-slate-400 font-medium">填写下方信息以开启一次新的签到任务</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative z-10">
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
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">课程分类</label>
                      <div className="relative">
                        <select 
                          value={newSessionData.category}
                          onChange={e => setNewSessionData(prev => ({ ...prev, category: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold appearance-none cursor-pointer shadow-sm"
                        >
                          {categories.filter(cat => cat !== '全部').map(cat => <option key={cat} value={cat}>{cat}</option>)}
                        </select>
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                          <ChevronRight className="w-4 h-4 rotate-90" />
                        </div>
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
                    <button 
                      onClick={() => setIsCreatingSession(false)} 
                      className="text-sm font-black text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      取消操作
                    </button>
                    <button 
                      onClick={handleCreateSession} 
                      className="px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 transition-all active:scale-95 flex items-center gap-2"
                    >
                      <Save className="w-5 h-5" />
                      确认创建
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
                        className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all cursor-pointer group relative overflow-hidden"
                      >
                        <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity">
                          <Calendar className="w-24 h-24" />
                        </div>
                        
                        <div className="flex items-start justify-between mb-6">
                          <div className="flex flex-col gap-2">
                            <span className={cn(
                              "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider w-fit",
                              session.category === '软件过程改进' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
                            )}>
                              {session.category}
                            </span>
                          </div>
                          {isAdmin && (
                            <button 
                              onClick={(e) => handleDeleteSession(session.id, e)}
                              className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        <h3 className="font-black text-xl text-slate-800 mb-2 leading-tight group-hover:text-indigo-600 transition-colors">{session.title}</h3>
                        <div className="flex items-center gap-2 text-slate-400 mb-6">
                          <Calendar className="w-3.5 h-3.5" />
                          <span className="text-xs font-medium">{new Date(session.date).toLocaleDateString()}</span>
                        </div>

                        <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-indigo-600 text-xs font-black uppercase tracking-wider">
                            进入课程
                            <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                          </div>
                          <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-indigo-50 transition-colors">
                            <ArrowLeft className="w-4 h-4 rotate-180 text-slate-400 group-hover:text-indigo-600" />
                          </div>
                        </div>
                      </motion.div>
                    ))
                )}
              </div>

              {sessions.filter(s => activeTab === '全部' || s.category === activeTab).length > sessionsPage * SESSIONS_PER_PAGE && (
                <div className="flex justify-center pt-4">
                  <button 
                    onClick={() => setSessionsPage(prev => prev + 1)}
                    className="px-8 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold text-slate-600 hover:text-indigo-600 hover:border-indigo-100 transition-all shadow-sm"
                  >
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
                  onClick={() => setView('home')}
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
                      <FileSpreadsheet className="w-4 h-4" />
                      导出 EXCEL
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
                      <span className={cn(
                        "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider",
                        currentSession?.category === '软件过程改进' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
                      )}>
                        {currentSession?.category}
                      </span>
                      <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {currentSession ? new Date(currentSession.date).toLocaleDateString() : ''}
                      </span>
                    </div>
                    <h2 className="text-4xl font-black text-slate-800 tracking-tight leading-tight">{currentSession?.title}</h2>
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
                        <p className="text-slate-400 text-sm font-medium ml-1">上传课堂合照，AI 将自动识别并同步签到名单</p>
                      </div>
                      <label className="cursor-pointer px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-sm font-black transition-all flex items-center gap-2 shadow-xl shadow-indigo-100 active:scale-95">
                        <Upload className="w-4 h-4" />
                        选择照片
                        <input type="file" multiple accept="image/*" className="hidden" onChange={onFileChange} disabled={isProcessing} />
                      </label>
                    </div>

                    {files.length > 0 && (
                      <div className="mt-8 space-y-6 relative z-10">
                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                          {files.map((file, idx) => (
                            <motion.div 
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              key={file.id} 
                              className="relative aspect-square rounded-2xl overflow-hidden border-2 border-slate-100 group shadow-sm"
                            >
                              <img src={file.preview} className="w-full h-full object-cover transition-transform group-hover:scale-110" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <button 
                                  onClick={() => setFiles(prev => prev.filter(f => f.id !== file.id))} 
                                  className="p-2 bg-red-500 text-white rounded-xl shadow-lg hover:bg-red-600 transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="absolute bottom-2 left-2 px-2 py-0.5 bg-black/60 backdrop-blur-md rounded-lg text-[10px] font-black text-white">#{idx+1}</div>
                            </motion.div>
                          ))}
                        </div>

                        <button 
                          onClick={handleAIProcess}
                          disabled={isProcessing}
                          className={cn(
                            "w-full py-4 rounded-2xl font-black flex items-center justify-center gap-3 transition-all shadow-xl",
                            isProcessing 
                              ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                              : "bg-slate-900 hover:bg-slate-800 text-white active:scale-[0.99]"
                          )}
                        >
                          {isProcessing ? (
                            <><Loader2 className="w-6 h-6 animate-spin" /> 正在识别中...</>
                          ) : (
                            <><CheckCircle2 className="w-6 h-6" /> 立即开始 AI 识别并同步</>
                          )}
                        </button>
                      </div>
                    )}
                    {error && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-4 p-5 bg-red-50 border border-red-200 rounded-2xl text-red-600 text-sm font-bold flex flex-col gap-2 shadow-sm"
                      >
                        <div className="flex items-center gap-3">
                          <AlertCircle className="w-5 h-5 flex-shrink-0" /> 
                          <span>AI 处理过程中出现错误</span>
                        </div>
                        <div className="pl-8 text-xs font-medium opacity-80 leading-relaxed">
                          {error}
                        </div>
                      </motion.div>
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
                        <input 
                          type="text" 
                          placeholder="搜索特征描述 (例如: 眼镜, 红衣...)"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="w-full pl-11 pr-4 py-2.5 bg-slate-50 border border-slate-100 rounded-xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all text-sm font-medium text-slate-700 placeholder:text-slate-400"
                        />
                      </div>
                      {!isAdmin && (
                        <button 
                          onClick={() => setIsStudentSignInOpen(true)} 
                          className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black rounded-xl flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap shadow-lg shadow-indigo-100"
                        >
                          <Plus className="w-4 h-4" /> 学生签到
                        </button>
                      )}
                      {isAdmin && (
                        <button 
                          onClick={handleAddManualRecord} 
                          className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-black rounded-xl flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap"
                        >
                          <Plus className="w-4 h-4" /> 手动补录
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-[2rem] border border-slate-100 bg-slate-50/30">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/80 backdrop-blur-md border-b border-slate-100">
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">人员标识</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">姓名</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">学号</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">特征描述</th>
                          <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">识别特写</th>
                          {isAdmin && <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">操作</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {currentSession?.records
                          .filter(record => 
                            record.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            record.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (record.studentId || '').toLowerCase().includes(searchTerm.toLowerCase())
                          )
                          .slice(0, recordsPage * RECORDS_PER_PAGE)
                          .map(record => (
                            <tr key={record.personId} className="hover:bg-white transition-all group">
                            <td className="px-8 py-6">
                              <span className="text-xs font-black font-mono text-slate-300 bg-slate-100 px-2 py-1 rounded-lg">
                                {record.personId}
                              </span>
                            </td>
                            <td className="px-8 py-6">
                              <div className="flex items-center gap-2">
                                <input 
                                  type="text" 
                                  placeholder="姓名"
                                  value={record.name}
                                  onChange={(e) => handleRecordUpdate(record.personId, { name: e.target.value })}
                                  className="bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-indigo-500 focus:outline-none py-1 text-base font-black text-slate-700 transition-all w-24 placeholder:text-slate-300"
                                />
                                <Edit2 className="w-3 h-3 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </div>
                            </td>
                            <td className="px-8 py-6">
                              <div className="flex items-center gap-2">
                                <input 
                                  type="text" 
                                  placeholder="学号"
                                  value={record.studentId || ''}
                                  onChange={(e) => handleRecordUpdate(record.personId, { studentId: e.target.value })}
                                  className="bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-indigo-500 focus:outline-none py-1 text-sm font-bold text-slate-600 transition-all w-28 placeholder:text-slate-300"
                                />
                              </div>
                            </td>
                            <td className="px-8 py-6">
                              <p className="text-sm text-slate-500 font-medium leading-relaxed max-w-xs">{record.description}</p>
                            </td>
                            <td className="px-8 py-6">
                              <div className="flex flex-wrap gap-3">
                                {record.appearances.map((app, i) => (
                                  <motion.button 
                                    whileHover={{ scale: 1.1, rotate: 2 }}
                                    key={i}
                                    onClick={() => setSelectedImage({ src: getFilePreview(app), box: app.box_2d })}
                                    className="relative"
                                  >
                                    <FaceHighlight src={getFilePreview(app)} box={app.box_2d} className="w-14 h-14 rounded-2xl" />
                                  </motion.button>
                                ))}
                                {record.photo && (
                                  <motion.button 
                                    whileHover={{ scale: 1.1, rotate: 2 }}
                                    onClick={() => setSelectedImage({ src: record.photo! })}
                                    className="relative"
                                  >
                                    <img src={record.photo} className="w-14 h-14 rounded-2xl object-cover border-2 border-indigo-200" />
                                  </motion.button>
                                )}
                                {record.appearances.length === 0 && !record.photo && (
                                  <div className="w-14 h-14 rounded-2xl bg-slate-100 border-2 border-dashed border-slate-200 flex items-center justify-center">
                                    <User className="w-5 h-5 text-slate-300" />
                                  </div>
                                )}
                              </div>
                            </td>
                            {isAdmin && (
                              <td className="px-8 py-6 text-right">
                                <button 
                                  onClick={() => handleDeleteRecord(record.personId)} 
                                  className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-2xl transition-all active:scale-90"
                                >
                                  <Trash2 className="w-5 h-5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {currentSession?.records.filter(record => 
                            record.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            record.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (record.studentId || '').toLowerCase().includes(searchTerm.toLowerCase())
                          ).length > recordsPage * RECORDS_PER_PAGE && (
                      <div className="p-6 text-center border-t border-slate-100">
                        <button 
                          onClick={() => setRecordsPage(prev => prev + 1)}
                          className="px-6 py-2 text-sm font-bold text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                        >
                          加载更多记录 ({currentSession?.records.length - recordsPage * RECORDS_PER_PAGE} 条待加载)
                        </button>
                      </div>
                    )}
                    {currentSession?.records.length === 0 && (
                      <div className="py-20 text-center space-y-4">
                        <div className="w-20 h-20 bg-slate-100 rounded-[2rem] flex items-center justify-center mx-auto">
                          <Users className="w-10 h-10 text-slate-300" />
                        </div>
                        <p className="text-slate-400 font-bold">暂无签到记录，请上传照片或手动补录</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Student Sign-in Modal */}
      <AnimatePresence>
        {isStudentSignInOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md"
            onClick={() => setIsStudentSignInOpen(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="bg-white max-w-md w-full rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 blur-3xl -mr-16 -mt-16 pointer-events-none" />
              
              <div className="flex flex-col items-center text-center mb-8">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-100 mb-4">
                  <User className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-2xl font-black text-slate-800 tracking-tight">{isAdmin ? '手动补录' : '学生自主签到'}</h3>
                <p className="text-sm text-slate-400 font-medium mt-1">请填写您的个人信息完成签到</p>
              </div>

              <form onSubmit={handleStudentSignIn} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">姓名</label>
                  <input 
                    type="text" 
                    required
                    value={studentSignInData.name}
                    onChange={e => setStudentSignInData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300"
                    placeholder="请输入姓名"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">学号</label>
                  <input 
                    type="text" 
                    required
                    value={studentSignInData.studentId}
                    onChange={e => setStudentSignInData(prev => ({ ...prev, studentId: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300"
                    placeholder="请输入学号"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">上传照片 (可选)</label>
                  <div className="flex items-center gap-4">
                    <label className="flex-1 cursor-pointer px-6 py-4 bg-slate-50 border border-dashed border-slate-200 rounded-2xl hover:bg-slate-100 transition-all flex flex-col items-center justify-center gap-2">
                      {studentSignInData.photo ? (
                        <img src={studentSignInData.photo} className="w-16 h-16 rounded-xl object-cover" />
                      ) : (
                        <>
                          <ImageIcon className="w-6 h-6 text-slate-300" />
                          <span className="text-xs text-slate-400 font-bold">点击上传</span>
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
                  <button 
                    type="button"
                    onClick={() => setIsStudentSignInOpen(false)}
                    className="flex-1 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-black transition-all active:scale-95"
                  >
                    取消
                  </button>
                  <button 
                    type="submit"
                    disabled={isSubmittingSignIn}
                    className="flex-1 px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {isSubmittingSignIn ? '提交中...' : '确认签到'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Login Modal */}
      <AnimatePresence>
        {isLoginModalOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md"
            onClick={() => setIsLoginModalOpen(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="bg-white max-w-md w-full rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 blur-3xl -mr-16 -mt-16 pointer-events-none" />
              
              <div className="flex flex-col items-center text-center mb-8">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-100 mb-4">
                  <Lock className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-2xl font-black text-slate-800 tracking-tight">管理员登录</h3>
                <p className="text-sm text-slate-400 font-medium mt-1">请输入凭据以访问管理功能</p>
              </div>

              <form onSubmit={handleLogin} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">用户名</label>
                  <input 
                    type="text" 
                    required
                    value={loginData.username}
                    onChange={e => setLoginData(prev => ({ ...prev, username: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300"
                    placeholder="请输入用户名"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">密码</label>
                  <input 
                    type="password" 
                    required
                    value={loginData.password}
                    onChange={e => setLoginData(prev => ({ ...prev, password: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 focus:bg-white outline-none transition-all text-slate-800 font-bold placeholder:text-slate-300"
                    placeholder="请输入密码"
                  />
                </div>

                {loginError && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-red-50 border border-red-100 rounded-2xl text-red-500 text-xs font-bold flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4" />
                    {loginError}
                  </motion.div>
                )}

                <div className="flex gap-4 pt-2">
                  <button 
                    type="button"
                    onClick={() => setIsLoginModalOpen(false)}
                    className="flex-1 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-black transition-all active:scale-95"
                  >
                    取消
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 transition-all active:scale-95"
                  >
                    登录
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modal */}
      <AnimatePresence>
        {selectedImage && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/95 backdrop-blur-xl"
            onClick={() => setSelectedImage(null)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="relative max-w-5xl w-full max-h-full flex items-center justify-center"
              onClick={e => e.stopPropagation()}
            >
              <div className="relative rounded-[2.5rem] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.5)] border border-white/10">
                <img src={selectedImage.src} className="max-w-full max-h-[80vh] object-contain" />
                {selectedImage.box && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.3, type: 'spring' }}
                    className="absolute border-4 border-yellow-400 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.7),0_0_30px_rgba(255,255,0,0.5)]"
                    style={{
                      top: `${selectedImage.box[0] / 10}%`,
                      left: `${selectedImage.box[1] / 10}%`,
                      width: `${(selectedImage.box[3] - selectedImage.box[1]) / 10}%`,
                      height: `${(selectedImage.box[2] - selectedImage.box[0]) / 10}%`,
                    }}
                  />
                )}
              </div>
              <button 
                onClick={() => setSelectedImage(null)} 
                className="absolute -top-16 right-0 md:-right-16 w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white backdrop-blur-md border border-white/20 transition-all active:scale-90"
              >
                <X className="w-6 h-6" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* API Key Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-slate-800">系统配置</h3>
                  <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-slate-100 rounded-full">
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
                
                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Gemini API Key</label>
                    <div className="relative">
                      <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input 
                        type="password"
                        value={userApiKey}
                        onChange={(e) => setUserApiKey(e.target.value)}
                        placeholder="输入您的 API Key..."
                        className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all text-sm"
                      />
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                      Key 将保存在本地浏览器中。如果未填写，系统将尝试使用服务器默认配置。
                    </p>
                  </div>

                  {isAdmin && (
                    <div className="pt-4 border-t border-slate-100">
                      <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">并发与压力测试 (管理员)</h4>
                      <button 
                        onClick={async () => {
                          if (!currentSession) {
                            alert("请先进入一个课程再进行测试");
                            return;
                          }
                          const testCount = 5;
                          console.log(`Starting concurrency test with ${testCount} requests...`);
                          const startTime = Date.now();
                          const promises = Array.from({ length: testCount }).map((_, i) => 
                            fetch(`/api/sessions/${currentSession.id}/sync`, {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ records: [{ id: `TEST_${i}`, description: `并发测试数据 ${i}`, appearances: [] }], images: [] })
                            }).then(r => r.json())
                          );
                          const results = await Promise.all(promises);
                          const duration = Date.now() - startTime;
                          alert(`并发测试完成！\n请求数: ${testCount}\n耗时: ${duration}ms\n成功数: ${results.filter(r => r.success).length}`);
                          fetchSessionDetail(currentSession.id);
                        }}
                        className="w-full py-3 px-4 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                      >
                        运行 5 次并发同步测试
                      </button>
                    </div>
                  )}

                  {window.aistudio && (
                    <button 
                      onClick={handleOpenSelectKey}
                      className="w-full py-3 px-4 bg-indigo-50 text-indigo-700 rounded-xl text-sm font-bold hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2"
                    >
                      使用 AI Studio 官方选 Key 助手
                    </button>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button 
                      onClick={() => setIsSettingsOpen(false)}
                      className="flex-1 py-3 px-4 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200 transition-colors"
                    >
                      取消
                    </button>
                    <button 
                      onClick={() => saveApiKey(userApiKey)}
                      className="flex-1 py-3 px-4 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                    >
                      保存配置
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Confirm Delete Modal */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md"
            onClick={() => setConfirmDelete(null)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
              className="bg-white max-w-sm w-full rounded-[2.5rem] p-10 shadow-2xl text-center"
              onClick={e => e.stopPropagation()}
            >
              <div className="w-16 h-16 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <Trash2 className="w-8 h-8" />
              </div>
              <h3 className="text-2xl font-black text-slate-800 mb-2">确认删除？</h3>
              <p className="text-slate-500 text-sm font-medium mb-8">
                {confirmDelete.type === 'session' ? '此操作将永久删除该课程及其所有签到记录，不可恢复。' : '此操作将永久删除该学生的签到记录。'}
              </p>
              <div className="flex gap-4">
                <button 
                  onClick={() => setConfirmDelete(null)}
                  className="flex-1 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-2xl font-black transition-all"
                >
                  取消
                </button>
                <button 
                  onClick={confirmDeleteAction}
                  className="flex-1 px-6 py-4 bg-red-500 hover:bg-red-600 text-white rounded-2xl font-black shadow-xl shadow-red-100 transition-all"
                >
                  确认删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
