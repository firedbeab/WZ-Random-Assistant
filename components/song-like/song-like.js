const theme=require('../../utils/theme');
const likes=require('../../utils/song-likes');
Component(theme.component({
 properties:{scheduleId:{type:String,value:''},row:{type:String,value:''},title:{type:String,value:''},singer:{type:String,value:''},refreshToken:{type:Number,value:0}},
 data:{ready:false,liked:false,count:0,pending:false,interactive:false,failed:false},
 observers:{'scheduleId,row,title,singer,refreshToken'(){if(this._mounted)this.bindSong();}},
 lifetimes:{attached(){this._mounted=true;this.bindSong();},detached(){this._mounted=false;if(this._releaseLikes)this._releaseLikes();}},
 methods:{
  bindSong(){
   if(this._releaseLikes)this._releaseLikes();const p=this.properties;
   if(!p.scheduleId){this.setData({ready:false});return;}
   this._releaseLikes=likes.subscribe(p.scheduleId,s=>{
    const item=s.value&&s.value.items.find(r=>r.row===p.row&&r.title===p.title&&r.singer===p.singer);
    this._item=item;
    this.setData({ready:!!item,failed:!!s.error,liked:!!(item&&item.liked),count:item?item.count:0,pending:!!(item&&s.pending.has(item.id)),interactive:!!(item&&item.interactive)});
   });likes.load(p.scheduleId,!!p.refreshToken).catch(()=>{});
  },
  async tap(){
   if(this.data.pending)return;
   try{if(this.data.failed||!this.data.ready){await likes.load(this.properties.scheduleId,true);return;}
    if(!this.data.interactive)return;await likes.setLike(this.properties.scheduleId,this._item.id);
   }catch(e){if(this._mounted)this.triggerEvent('notify',{message:e.message});}
  },
  noop(){}
 }
}));
