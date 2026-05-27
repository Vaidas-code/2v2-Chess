import Navbar from '../components/Navbar.jsx'
import homeBackgroundImage from '../assets/images/2v2chess_home.png'

function getStoredUser() {
  try {
    const raw = localStorage.getItem('authUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export default function HowToPlayPage() {
  const user = getStoredUser()

  return (
    <div className="h-dvh overflow-hidden bg-slate-950 text-slate-100">
      <Navbar />

      <section
        className="relative flex h-[calc(100dvh-4rem)] items-center justify-center overflow-hidden"
        style={{
          backgroundImage: `url(${homeBackgroundImage})`,
          backgroundPosition: 'center',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-slate-950/65" />

        <div
          className="relative z-10 w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900/80 px-8 py-7 shadow-2xl shadow-black/50"
          style={{ backdropFilter: 'blur(16px)' }}
        >
          <h1 className="text-center text-2xl font-extrabold uppercase tracking-widest text-white">
            How to Play
          </h1>
          <p className="mt-1 text-center text-xs text-slate-400">
            {user?.username ? `Welcome, ${user.username}` : 'Available for all players'}
          </p>

          <ol className="mt-5 space-y-3 text-sm leading-relaxed text-slate-200">
            <li><span className="font-semibold text-white">1.</span> Two teams of two players play on two boards.</li>
            <li><span className="font-semibold text-white">2.</span> When you capture a piece, your teammate receives that piece in reserve.</li>
            <li><span className="font-semibold text-white">3.</span> On your turn, you may place a reserve piece on any empty square instead of making a normal move.</li>
            <li><span className="font-semibold text-white">4.</span> Pawns from reserve cannot be dropped on the first or last rank.</li>
            <li><span className="font-semibold text-white">5.</span> Checkmate on either board wins the game for your team.</li>
          </ol>
        </div>
      </section>
    </div>
  )
}
