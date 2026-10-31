const cloud=require('wx-server-sdk');
const {createService}=require('./service');
const {createDataScope,canUseTestData}=require('./dataScope');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database({throwOnNotFound:false});
const service=createService({db,createDataScope,canUseTestData});
exports.main=async(event={})=>service(event,cloud.getWXContext().OPENID);
